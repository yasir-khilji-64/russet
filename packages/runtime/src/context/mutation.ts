import { dirname } from 'node:path';

import type { WorkspacePolicy } from '../policy/types.js';
import type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
  Workspace,
} from '../workspace/types.js';
import { loadWorkspaceInstructions } from './instructions.js';
import type { WorkspaceContext } from './provider.js';
import type { InstructionTarget } from './types.js';

type MutationResource = ExistingWorkspaceResource | NewWorkspaceFileTarget;

export interface MutationContextGuard {
  check(
    runId: string,
    resource: MutationResource,
    signal: AbortSignal,
  ): Promise<'ready' | 'refresh'>;
}

export interface MutationContextGuardOptions {
  readonly workspace: Workspace;
  readonly policy: WorkspacePolicy;
  readonly context: WorkspaceContext;
  readonly onRelevantTarget: (target: InstructionTarget) => void;
}

function appliesTo(scope: string, directory: string): boolean {
  return (
    scope === '.' || directory === scope || directory.startsWith(`${scope}/`)
  );
}

export function createMutationContextGuard(
  options: MutationContextGuardOptions,
): MutationContextGuard {
  return {
    async check(runId, resource, signal) {
      signal.throwIfAborted();

      const target: InstructionTarget =
        resource.kind === 'missing'
          ? {
              kind: 'new_file',
              path: resource.relativePath,
            }
          : {
              kind: resource.kind,
              path: resource.relativePath,
            };

      const current = await loadWorkspaceInstructions(
        options.workspace,
        options.policy,
        target,
        signal,
      );

      signal.throwIfAborted();

      const prepared = options.context.inspectPreparedForRun(runId);

      const directory =
        resource.kind === 'directory'
          ? resource.relativePath
          : dirname(resource.relativePath);

      const expected = prepared?.sources
        .filter((source) => appliesTo(source.scope, directory))
        .map((source) => `${source.path}\0${source.sha256}`)
        .toSorted();

      const actual = current.sources
        .map((source) => `${source.path}\0${source.sha256}`)
        .toSorted();

      if (
        expected !== undefined &&
        expected.length === actual.length &&
        expected.every((value, index) => value === actual[index])
      ) {
        return 'ready';
      }

      // Instruct the next inference preparation to include
      // the previously missing or changed instruction scope.
      options.onRelevantTarget(target);

      return 'refresh';
    },
  };
}
