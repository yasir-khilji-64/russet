import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type {
  AgentContextProvider,
  AgentContextRequest,
  PreparedAgentContext,
} from '@russet/agent';

import { evaluateWorkspacePolicy } from '../policy/evaluate.js';
import type { WorkspacePolicy } from '../policy/types.js';
import {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../workspace/paths.js';
import type { Workspace } from '../workspace/types.js';
import {
  ContextAssemblyError,
  renderWorkspaceInstructions,
} from './assemble.js';
import { loadWorkspaceInstructions } from './instructions.js';
import type { InstructionSource, InstructionTarget } from './types.js';

const DEFAULT_MAX_RENDERED_BYTES = 64 * 1024;
const MAX_RENDERED_BYTES = 128 * 1024;
const MAX_ACTIVE_TARGETS = 8;
const MAX_UNIQUE_SOURCES = 64;

export interface ContextSourceSummary {
  readonly path: string;
  readonly scope: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface WorkspaceContextSnapshot {
  readonly revision: string;
  readonly targets: readonly InstructionTarget[];
  readonly sources: readonly ContextSourceSummary[];
  readonly renderedBytes: number;
}

export interface WorkspaceContextOptions {
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;
  readonly maxRenderedBytes?: number;
}

export interface WorkspaceContext extends AgentContextProvider {
  setRelevantTargets(targets: readonly InstructionTarget[]): void;
  inspectLastPrepared(): WorkspaceContextSnapshot | undefined;
  inspectPreparedForRun(runId: string): WorkspaceContextSnapshot | undefined;
}

function defaultTargets(): readonly InstructionTarget[] {
  return Object.freeze([
    Object.freeze({
      kind: 'directory' as const,
      path: '.',
    }),
  ]);
}

function normalizeTargets(
  targets: readonly InstructionTarget[],
): readonly InstructionTarget[] {
  if (!Array.isArray(targets) || targets.length > MAX_ACTIVE_TARGETS) {
    throw new ContextAssemblyError(
      'invalid_target',
      'Too many context targets.',
    );
  }

  if (targets.length === 0) {
    return defaultTargets();
  }

  const unique = new Map<string, InstructionTarget>();

  for (const target of targets) {
    if (
      !target ||
      (target.kind !== 'file' &&
        target.kind !== 'directory' &&
        target.kind !== 'new_file') ||
      typeof target.path !== 'string' ||
      target.path.length === 0
    ) {
      throw new ContextAssemblyError(
        'invalid_target',
        'Invalid context target.',
      );
    }

    const copy = Object.freeze({
      kind: target.kind,
      path: target.path,
    });

    unique.set(JSON.stringify([copy.kind, copy.path]), copy);
  }

  return Object.freeze(
    [...unique.values()].toSorted((a, b) => {
      const left = `${a.path}\0${a.kind}`;
      const right = `${b.path}\0${b.kind}`;

      return left < right ? -1 : left > right ? 1 : 0;
    }),
  );
}

function scopeDepth(scope: string): number {
  return scope === '.' ? 0 : scope.split('/').length;
}

function sourceOrder(a: InstructionSource, b: InstructionSource): number {
  const distance = scopeDepth(a.scope) - scopeDepth(b.scope);
  if (distance !== 0) {
    return distance;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

class WorkspaceContextImpl implements WorkspaceContext {
  private readonly workspace: Workspace;
  private readonly policy: WorkspacePolicy;
  private readonly maxRenderedBytes: number;

  private targets: readonly InstructionTarget[] = defaultTargets();

  private selectionVersion = 0;

  private lastSnapshot: WorkspaceContextSnapshot | undefined;

  private preparedRun:
    | {
        readonly runId: string;
        readonly snapshot: WorkspaceContextSnapshot;
      }
    | undefined;

  constructor(options: WorkspaceContextOptions) {
    this.workspace = options.workspace;
    this.policy = options.policy;

    this.maxRenderedBytes =
      options.maxRenderedBytes ?? DEFAULT_MAX_RENDERED_BYTES;

    if (
      !Number.isSafeInteger(this.maxRenderedBytes) ||
      this.maxRenderedBytes <= 0 ||
      this.maxRenderedBytes > MAX_RENDERED_BYTES
    ) {
      throw new ContextAssemblyError(
        'invalid_options',
        'Invalid rendered-context byte budget.',
      );
    }
  }

  setRelevantTargets(targets: readonly InstructionTarget[]): void {
    this.targets = normalizeTargets(targets);
    this.selectionVersion++;
    this.lastSnapshot = undefined;
  }

  inspectLastPrepared(): WorkspaceContextSnapshot | undefined {
    return this.lastSnapshot;
  }

  inspectPreparedForRun(runId: string): WorkspaceContextSnapshot | undefined {
    return this.preparedRun?.runId === runId
      ? this.preparedRun.snapshot
      : undefined;
  }

  async prepare(request: AgentContextRequest): Promise<PreparedAgentContext> {
    request.signal.throwIfAborted();

    const selectionVersion = this.selectionVersion;
    const targets = this.targets;

    const byPath = new Map<string, InstructionSource>();
    const normalizedTargets: InstructionTarget[] = [];

    for (const target of targets) {
      request.signal.throwIfAborted();

      const resolved =
        target.kind === 'new_file'
          ? await resolveNewWorkspaceFilePath(this.workspace, target.path)
          : await resolveExistingWorkspacePath(this.workspace, target.path);

      if (target.kind !== 'new_file' && resolved.kind !== target.kind) {
        throw new ContextAssemblyError(
          'invalid_target',
          'Context target kind does not match the filesystem.',
        );
      }

      const isNewFile = target.kind === 'new_file';

      const action =
        isNewFile || target.kind === 'directory'
          ? ('fs.search' as const)
          : ('fs.read' as const);

      const decision = evaluateWorkspacePolicy(this.policy, {
        action: action,
        kind: isNewFile ? 'directory' : resolved.kind,
        relativePath: isNewFile
          ? posix.dirname(resolved.relativePath)
          : resolved.relativePath,
      });

      if (decision.decision !== 'allow') {
        throw new ContextAssemblyError(
          'target_not_permitted',
          'Context target is not authorized.',
        );
      }

      normalizedTargets.push(
        Object.freeze({
          kind: target.kind,
          path: resolved.relativePath,
        }),
      );

      const loaded = await loadWorkspaceInstructions(
        this.workspace,
        this.policy,
        target,
        request.signal,
      );

      for (const source of loaded.sources) {
        const previous = byPath.get(source.path);

        if (previous && previous.sha256 !== source.sha256) {
          throw new ContextAssemblyError(
            'sources_changed',
            'Instruction source changed during context preparation.',
          );
        }

        byPath.set(source.path, source);
      }
    }

    const sources = [...byPath.values()].toSorted(sourceOrder);

    if (sources.length > MAX_UNIQUE_SOURCES) {
      throw new ContextAssemblyError(
        'too_many_sources',
        'Too many context instruction sources.',
      );
    }

    const instructions = renderWorkspaceInstructions(sources);

    const renderedBytes = Buffer.byteLength(instructions, 'utf8');

    if (renderedBytes > this.maxRenderedBytes) {
      throw new ContextAssemblyError(
        'render_budget_exceeded',
        'Workspace instructions exceed the rendered-context byte budget.',
      );
    }

    const uniqueTargets = normalizeTargets(normalizedTargets);

    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          root: this.workspace.rootPath,
          identity: this.workspace.identity,
          targets: uniqueTargets,
          sources: sources.map(({ path, scope, sha256 }) => ({
            path,
            scope,
            sha256,
          })),
        }),
      )
      .digest('hex');

    request.signal.throwIfAborted();

    if (this.selectionVersion !== selectionVersion) {
      throw new ContextAssemblyError(
        'selection_changed',
        'Context targets changed during preparation.',
      );
    }

    const sourceSummaries = Object.freeze(
      sources.map(({ path, scope, sha256, sizeBytes }) =>
        Object.freeze({
          path,
          scope,
          sha256,
          sizeBytes,
        }),
      ),
    );

    const snapshot: WorkspaceContextSnapshot = Object.freeze({
      revision,
      targets: uniqueTargets,
      sources: sourceSummaries,
      renderedBytes,
    });

    this.lastSnapshot = snapshot;
    this.preparedRun = {
      runId: request.runId,
      snapshot: this.lastSnapshot,
    };

    return { instructions, revision };
  }
}

export function createWorkspaceContext(
  options: WorkspaceContextOptions,
): WorkspaceContext {
  return new WorkspaceContextImpl(options);
}
