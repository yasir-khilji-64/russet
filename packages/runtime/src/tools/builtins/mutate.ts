import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../../workspace/paths.js';
import type { Workspace } from '../../workspace/types.js';
import { ManagedToolError, WritePreconditionError } from '../errors.js';
import { MAX_TEXT_FILE_BYTES, readWorkspaceText } from './text.js';

export function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function checkContent(content: string): void {
  if (
    content.includes('\0') ||
    Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES
  ) {
    throw new WritePreconditionError(
      'File content is invalid or exceeds the write limit.',
    );
  }
}

function checkHash(actual: string, expected: string): void {
  if (textSha256(actual) !== expected) {
    throw new WritePreconditionError(
      'The file has changed since its expected version.',
    );
  }
}

/**
 * Stage complete UTF-8 content in the target directory.
 * The temporary pathname is exclusive and initially private.
 */
async function stageFile(
  destination: string,
  content: string,
  mode: number,
  signal: AbortSignal,
): Promise<string> {
  const temporary = join(dirname(destination), `.russet-${randomUUID()}.tmp`);

  const handle = await open(temporary, 'wx', 0o600);
  let ready = false;

  try {
    signal.throwIfAborted();

    await handle.writeFile(content, 'utf8');

    signal.throwIfAborted();

    await handle.chmod(mode);
    await handle.sync();
    await handle.close();

    ready = true;
    return temporary;
  } finally {
    if (!ready) {
      // Cleanup failures must not be mistaken for clean rollback.
      await handle.close().catch(() => undefined);
      await unlink(temporary);
    }
  }
}

/**
 * Creates a new file without replacing an existing final target.
 */
export async function createWorkspaceFile(
  workspace: Workspace,
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<string> {
  checkContent(content);
  signal.throwIfAborted();

  const target = await resolveNewWorkspaceFilePath(workspace, path);

  const mode = 0o644 & ~process.umask();

  const temporary = await stageFile(target.absolutePath, content, mode, signal);

  try {
    signal.throwIfAborted();

    await resolveNewWorkspaceFilePath(workspace, target.relativePath);

    signal.throwIfAborted();

    // POSIX link creates the destination only if absent.
    // Unlike rename, it does not overwrite an existing target.
    await link(temporary, target.absolutePath);
  } finally {
    await unlink(temporary);
  }

  return textSha256(content);
}

/**
 * Replaces a regular file only when its current content
 * matches an explicitly supplied SHA-256 precondition.
 *
 * The final rename is not a cross-process compare-and-swap.
 */
export async function replaceWorkspaceFile(
  workspace: Workspace,
  path: string,
  content: string,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<string> {
  checkContent(content);
  signal.throwIfAborted();

  const target = await resolveExistingWorkspacePath(workspace, path);

  if (target.kind !== 'file') {
    throw new WritePreconditionError(
      'Replacement requires an existing regular file.',
    );
  }

  const current = await readWorkspaceText(
    workspace,
    target.relativePath,
    signal,
  );

  checkHash(current, expectedSha256);

  const original = await lstat(target.absolutePath, { bigint: true });

  if (!original.isFile()) {
    throw new WritePreconditionError(
      'Replacement target is no longer a regular file.',
    );
  }

  const mode = Number(original.mode & 0o777n);

  const temporary = await stageFile(target.absolutePath, content, mode, signal);

  try {
    signal.throwIfAborted();

    const latest = await readWorkspaceText(
      workspace,
      target.relativePath,
      signal,
    );

    if (textSha256(latest) !== expectedSha256) {
      throw new ManagedToolError(
        'The file changed while replacement was being prepared.',
      );
    }

    signal.throwIfAborted();

    await rename(temporary, target.absolutePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (
        cleanupError === null ||
        typeof cleanupError !== 'object' ||
        !('code' in cleanupError) ||
        cleanupError.code !== 'ENOENT'
      ) {
        throw new AggregateError(
          [error, cleanupError],
          'File replacement failed and staged-file cleanup failed.',
          { cause: cleanupError },
        );
      }
    }

    throw error;
  }

  return textSha256(content);
}

/**
 * Exact-match editing. Rejects missing or ambiguous matches.
 */
export async function editWorkspaceFile(
  workspace: Workspace,
  path: string,
  oldText: string,
  newText: string,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<string> {
  if (!oldText) {
    throw new WritePreconditionError('Edit search text must not be empty.');
  }

  const current = await readWorkspaceText(workspace, path, signal);

  checkHash(current, expectedSha256);

  const first = current.indexOf(oldText);

  if (first === -1) {
    throw new WritePreconditionError('Edit search text was not found.');
  }

  if (current.indexOf(oldText, first + 1) !== -1) {
    throw new WritePreconditionError('Edit search text is ambiguous.');
  }

  const updated =
    current.slice(0, first) + newText + current.slice(first + oldText.length);

  checkContent(updated);

  return replaceWorkspaceFile(workspace, path, updated, expectedSha256, signal);
}
