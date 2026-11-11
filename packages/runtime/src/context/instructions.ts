import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { evaluateWorkspacePolicy } from '../policy/evaluate.js';
import type { WorkspacePolicy } from '../policy/types.js';
import {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../workspace/paths.js';
import { WorkspaceError } from '../workspace/types.js';
import type { Workspace } from '../workspace/types.js';
import { assertWorkspaceIdentity } from '../workspace/workspace.js';
import { InstructionLoadError } from './types.js';
import type {
  InstructionSource,
  InstructionTarget,
  WorkspaceInstructions,
} from './types.js';

const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024;
const MAX_SOURCES = 16;
const MAX_SCOPE_DEPTH = 64;

function isNodeCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function scopesFor(directory: string): string[] {
  if (directory === '.') {
    return ['.'];
  }

  const parts = directory.split('/');

  if (parts.length > MAX_SCOPE_DEPTH) {
    throw new InstructionLoadError(
      'invalid_target',
      'Instruction target exceeds the maximum directory depth.',
    );
  }

  return ['.', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
}

async function readBounded(
  path: string,
  remainingBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let handle;
  signal?.throwIfAborted();

  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNodeCode(error, 'ELOOP')) {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction file became a symlink.',
        { cause: error },
      );
    }

    throw new InstructionLoadError(
      'source_unavailable',
      'Instruction file could not be opened.',
      { cause: error },
    );
  }

  try {
    const before = await handle.stat({ bigint: true });

    const namedBefore = await lstat(path, {
      bigint: true,
    });

    if (
      !before.isFile() ||
      !namedBefore.isFile() ||
      before.dev !== namedBefore.dev ||
      before.ino !== namedBefore.ino
    ) {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction source identity changed during acquisition.',
      );
    }

    if (!before.isFile()) {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction source is no longer a regular file.',
      );
    }

    if (before.size > BigInt(MAX_FILE_BYTES)) {
      throw new InstructionLoadError(
        'file_too_large',
        'Instruction file exceeds the per-file size limit.',
      );
    }

    if (before.size > BigInt(remainingBytes)) {
      throw new InstructionLoadError(
        'total_budget_exceeded',
        'Instruction files exceed the combined size limit.',
      );
    }

    const sizeLimit = Math.min(MAX_FILE_BYTES, remainingBytes);

    const buffer = Buffer.alloc(sizeLimit + 1);
    let readBytes = 0;

    while (readBytes < buffer.length) {
      signal?.throwIfAborted();

      const { bytesRead } = await handle.read(
        buffer,
        readBytes,
        buffer.length - readBytes,
        readBytes,
      );

      if (bytesRead === 0) {
        break;
      }

      readBytes += bytesRead;
    }

    if (readBytes > MAX_FILE_BYTES) {
      throw new InstructionLoadError(
        'file_too_large',
        'Instruction file exceeds the per-file size limit.',
      );
    }

    if (readBytes > remainingBytes) {
      throw new InstructionLoadError(
        'total_budget_exceeded',
        'Instruction files exceed the combined size limit.',
      );
    }

    const after = await handle.stat({ bigint: true });

    const namedAfter = await lstat(path, {
      bigint: true,
    });

    if (
      !namedAfter.isFile() ||
      namedAfter.dev !== before.dev ||
      namedAfter.ino !== before.ino ||
      namedAfter.size !== before.size ||
      namedAfter.mtimeNs !== before.mtimeNs ||
      namedAfter.ctimeNs !== before.ctimeNs
    ) {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction source changed while being read.',
      );
    }

    signal?.throwIfAborted();

    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(readBytes)
    ) {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction file changed while being read.',
      );
    }

    return buffer.subarray(0, readBytes);
  } catch (error) {
    if (error instanceof InstructionLoadError) {
      throw error;
    }

    if (signal?.aborted) {
      signal.throwIfAborted();
    }

    throw new InstructionLoadError(
      'source_unavailable',
      'Instruction file could not be read.',
      { cause: error },
    );
  } finally {
    await handle.close();
  }
}

export async function loadWorkspaceInstructions(
  workspace: Workspace,
  policy: WorkspacePolicy,
  target: InstructionTarget,
  signal?: AbortSignal,
): Promise<WorkspaceInstructions> {
  signal?.throwIfAborted();

  if (
    target.kind !== 'file' &&
    target.kind !== 'directory' &&
    target.kind !== 'new_file'
  ) {
    throw new InstructionLoadError(
      'invalid_target',
      'Unsupported instruction target kind.',
    );
  }

  const resolved =
    target.kind === 'new_file'
      ? await resolveNewWorkspaceFilePath(workspace, target.path)
      : await resolveExistingWorkspacePath(workspace, target.path);

  if (
    (target.kind === 'file' && resolved.kind !== 'file') ||
    (target.kind === 'directory' && resolved.kind !== 'directory')
  ) {
    throw new InstructionLoadError(
      'invalid_target',
      'Instruction target kind does not match the filesystem.',
    );
  }

  const directory =
    target.kind === 'directory'
      ? resolved.relativePath
      : dirname(resolved.relativePath);

  const sources: InstructionSource[] = [];
  let totalBytes = 0;

  for (const scope of scopesFor(directory)) {
    signal?.throwIfAborted();

    const path = scope === '.' ? 'AGENTS.md' : `${scope}/AGENTS.md`;

    let source;

    try {
      source = await resolveExistingWorkspacePath(workspace, path);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'not_found') {
        const parent = await resolveExistingWorkspacePath(workspace, scope);

        if (parent.kind !== 'directory') {
          throw new InstructionLoadError(
            'source_changed',
            'Instruction scope is no longer a directory.',
          );
        }

        continue;
      }

      throw error;
    }

    if (source.kind !== 'file') {
      throw new InstructionLoadError(
        'source_unavailable',
        `Instruction source '${path}' is not a file.`,
      );
    }

    const decision = evaluateWorkspacePolicy(policy, {
      action: 'fs.read',
      relativePath: source.relativePath,
      kind: 'file',
    });

    if (decision.decision !== 'allow') {
      throw new InstructionLoadError(
        'not_permitted',
        `Instruction source '${path}' requires read permission ` +
          `of allow (received ${decision.decision}).`,
      );
    }

    if (sources.length === MAX_SOURCES) {
      throw new InstructionLoadError(
        'too_many_sources',
        'Too many applicable instruction files.',
      );
    }

    const bytes = await readBounded(
      source.absolutePath,
      MAX_TOTAL_BYTES - totalBytes,
      signal,
    );

    signal?.throwIfAborted();

    const currentSource = await resolveExistingWorkspacePath(
      workspace,
      source.relativePath,
    );

    if (currentSource.kind !== 'file') {
      throw new InstructionLoadError(
        'source_changed',
        'Instruction source is no longer a regular file',
      );
    }

    await assertWorkspaceIdentity(workspace);

    let content: string;

    try {
      content = new TextDecoder('utf-8', {
        fatal: true,
      }).decode(bytes);
    } catch (error) {
      throw new InstructionLoadError(
        'invalid_encoding',
        `Instruction source '${path}' is not valid UTF-8.`,
        { cause: error },
      );
    }

    if (content.includes('\0')) {
      throw new InstructionLoadError(
        'invalid_encoding',
        `Instruction source '${path}' contains NUL bytes.`,
      );
    }

    if (content.trim().length === 0) {
      continue;
    }

    totalBytes += bytes.length;

    sources.push(
      Object.freeze({
        path: source.relativePath,
        scope,
        content,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      }),
    );
  }

  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        rootPath: workspace.rootPath,
        identity: workspace.identity,
        sources: sources.map(({ path, scope, sha256 }) => ({
          path,
          scope,
          sha256,
        })),
      }),
    )
    .digest('hex');

  return Object.freeze({
    sources: Object.freeze(sources),
    revision,
    totalBytes,
  });
}
