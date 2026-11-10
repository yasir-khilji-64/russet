import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { resolveExistingWorkspacePath } from '../../workspace/paths.js';
import type { Workspace } from '../../workspace/types.js';
import { assertWorkspaceIdentity } from '../../workspace/workspace.js';
import { ManagedToolError } from '../errors.js';

export const MAX_TEXT_FILE_BYTES = 256 * 1024;

const READ_CHUNK_BYTES = 16 * 1024;

export class UnsupportedTextFileError extends ManagedToolError {
  constructor(readonly reason: 'too_large' | 'binary' | 'invalid_encoding') {
    super(
      reason === 'too_large'
        ? 'File exceeds the 256 KiB text-reading limit.'
        : reason === 'binary'
          ? 'File contains binary data.'
          : 'File is not valid UTF-8 text.',
    );

    this.name = 'UnsupportedTextFileError';
  }
}

export async function readWorkspaceText(
  workspace: Workspace,
  relativePath: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();

  const resource = await resolveExistingWorkspacePath(workspace, relativePath);

  if (resource.kind !== 'file') {
    throw new ManagedToolError('Expected a regular file.');
  }

  const handle = await open(
    resource.absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const before = await handle.stat({ bigint: true });
    const named = await lstat(resource.absolutePath, {
      bigint: true,
    });

    if (
      !before.isFile() ||
      !named.isFile() ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    ) {
      throw new ManagedToolError('File identity changed during acquisition.');
    }

    await resolveExistingWorkspacePath(workspace, relativePath);

    if (before.size > BigInt(MAX_TEXT_FILE_BYTES)) {
      throw new UnsupportedTextFileError('too_large');
    }

    const chunks: Buffer[] = [];
    let position = 0;

    while (position <= MAX_TEXT_FILE_BYTES) {
      signal.throwIfAborted();

      const remaining = MAX_TEXT_FILE_BYTES + 1 - position;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));

      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );

      if (bytesRead === 0) {
        break;
      }

      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    if (position > MAX_TEXT_FILE_BYTES) {
      throw new UnsupportedTextFileError('too_large');
    }

    const after = await handle.stat({ bigint: true });

    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      BigInt(position) !== before.size
    ) {
      throw new ManagedToolError('File changed while being read.');
    }

    await assertWorkspaceIdentity(workspace);

    const current = await resolveExistingWorkspacePath(workspace, relativePath);

    const currentInfo = await lstat(current.absolutePath, {
      bigint: true,
    });

    if (
      !currentInfo.isFile() ||
      currentInfo.dev !== before.dev ||
      currentInfo.ino !== before.ino
    ) {
      throw new ManagedToolError('File changed while being read.');
    }

    signal.throwIfAborted();

    const bytes = Buffer.concat(chunks, position);

    if (bytes.includes(0)) {
      throw new UnsupportedTextFileError('binary');
    }

    try {
      return new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new UnsupportedTextFileError('invalid_encoding');
    }
  } finally {
    await handle.close();
  }
}
