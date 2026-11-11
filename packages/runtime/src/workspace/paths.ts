import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { WorkspaceError } from './types.js';
import type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
  Workspace,
} from './types.js';
import { assertWorkspaceIdentity } from './workspace.js';

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);

  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function parseRelativePath(
  workspace: Workspace,
  input: string,
): {
  absolutePath: string;
  relativePath: string;
} {
  if (!input || input.includes('\0')) {
    throw new WorkspaceError(
      'invalid_path',
      'Expected a workspace-relative POSIX path.',
    );
  }

  if (
    isAbsolute(input) ||
    /^[a-zA-Z]:/.test(input) ||
    input.split('/').includes('..')
  ) {
    throw new WorkspaceError(
      'outside_workspace',
      'Absolute and parent-traversal paths are not permitted.',
    );
  }

  if (input.includes('\\')) {
    throw new WorkspaceError(
      'invalid_path',
      'Backslashes are not supported in workspace paths.',
    );
  }

  const absolutePath = resolve(workspace.rootPath, input);

  if (!isWithinRoot(workspace.rootPath, absolutePath)) {
    throw new WorkspaceError(
      'outside_workspace',
      'Path escapes the workspace root.',
    );
  }

  return {
    absolutePath,
    relativePath: relative(workspace.rootPath, absolutePath) || '.',
  };
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function checkRealPath(
  workspace: Workspace,
  path: string,
): Promise<void> {
  const canonical = await realpath(path);

  if (!isWithinRoot(workspace.rootPath, canonical)) {
    throw new WorkspaceError(
      'outside_workspace',
      'Resolved path leaves the workspace root.',
    );
  }
}

async function inspect(
  workspace: Workspace,
  input: string,
  purpose: 'existing',
): Promise<ExistingWorkspaceResource>;

async function inspect(
  workspace: Workspace,
  input: string,
  purpose: 'new_file',
): Promise<NewWorkspaceFileTarget>;

async function inspect(
  workspace: Workspace,
  input: string,
  purpose: 'existing' | 'new_file',
): Promise<ExistingWorkspaceResource | NewWorkspaceFileTarget> {
  const target = parseRelativePath(workspace, input);

  await assertWorkspaceIdentity(workspace);

  if (target.relativePath === '.') {
    if (purpose === 'new_file') {
      throw new WorkspaceError(
        'invalid_path',
        'Cannot create a file at the workspace root.',
      );
    }

    return { ...target, kind: 'directory' };
  }

  if (purpose === 'new_file' && input.endsWith('/')) {
    throw new WorkspaceError(
      'invalid_path',
      'New file target must be a filename.',
    );
  }

  const segments = target.relativePath.split(sep);
  let current = workspace.rootPath;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);

    const isLast = index === segments.length - 1;

    let info;

    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        if (purpose === 'new_file' && isLast) {
          await checkRealPath(workspace, resolve(current, '..'));

          await assertWorkspaceIdentity(workspace);

          return { ...target, kind: 'missing' };
        }

        throw new WorkspaceError(
          'not_found',
          'Workspace resource does not exist.',
          { cause: error },
        );
      }

      throw new WorkspaceError(
        'resource_unavailable',
        'Workspace resource cannot be inspected.',
        { cause: error },
      );
    }

    if (info.isSymbolicLink()) {
      throw new WorkspaceError(
        'symlink_disallowed',
        'Symlinks are not allowed inside the workspace.',
      );
    }

    if (!isLast && !info.isDirectory()) {
      throw new WorkspaceError(
        'not_directory',
        'A resource parent is not a directory.',
      );
    }

    if (isLast) {
      if (purpose === 'new_file') {
        throw new WorkspaceError(
          'already_exists',
          'Workspace target already exists.',
        );
      }

      const kind = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : undefined;

      if (kind === undefined) {
        throw new WorkspaceError(
          'unsupported_resource',
          'Only ordinary files and directories are supported.',
        );
      }

      try {
        await checkRealPath(workspace, target.absolutePath);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          throw error;
        }

        throw new WorkspaceError(
          'resource_unavailable',
          'Resource changed while being inspected.',
          { cause: error },
        );
      }

      await assertWorkspaceIdentity(workspace);

      return { ...target, kind };
    }
  }

  throw new Error('Unreachable workspace path state.');
}

/**
 * Inspects an existing workspace resource.
 *
 * The returned path is not authorization to access it.
 */
export async function resolveExistingWorkspacePath(
  workspace: Workspace,
  input: string,
): Promise<ExistingWorkspaceResource> {
  return inspect(workspace, input, 'existing');
}

/**
 * Inspects a new file target with an existing parent directory.
 *
 * Does not create or reserve the target.
 */
export async function resolveNewWorkspaceFilePath(
  workspace: Workspace,
  input: string,
): Promise<NewWorkspaceFileTarget> {
  return inspect(workspace, input, 'new_file');
}
