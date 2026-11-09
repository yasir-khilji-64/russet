import { stat } from 'fs/promises';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  WorkspaceError,
  type Workspace,
  type WorkspaceIdentity,
} from './types.js';

async function directoryIdentity(path: string): Promise<WorkspaceIdentity> {
  const info = await stat(path, { bigint: true });

  if (!info.isDirectory()) {
    throw new WorkspaceError(
      'workspace_unavailable',
      'Workspace root is not a directory.',
    );
  }

  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
  };
}

export async function createWorkspace(
  selectedPath: string = process.cwd(),
): Promise<Workspace> {
  if (!selectedPath || selectedPath.includes('\0')) {
    throw new WorkspaceError('invalid_path', 'Invalid workspace root path.');
  }

  const absolute = resolve(selectedPath);

  try {
    const rootPath = await realpath(absolute);
    const identity = await directoryIdentity(rootPath);

    return Object.freeze({
      selectedPath: absolute,
      rootPath,
      identity,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }

    throw new WorkspaceError(
      'workspace_unavailable',
      'Workspace root cannot be resolved.',
      {
        cause: error,
      },
    );
  }
}

export async function assertWorkspaceIdentity(
  workspace: Workspace,
): Promise<void> {
  try {
    const currentRoot = await realpath(workspace.selectedPath);
    const identity = await directoryIdentity(currentRoot);

    if (
      currentRoot !== workspace.rootPath ||
      identity.device !== workspace.identity.device ||
      identity.inode !== workspace.identity.inode
    ) {
      throw new WorkspaceError(
        'workspace_changed',
        'Workspace root has changed.',
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'workspace_changed') {
      throw error;
    }

    throw new WorkspaceError(
      'workspace_changed',
      'Workspace root is unavailable or has changed.',
      { cause: error },
    );
  }
}
