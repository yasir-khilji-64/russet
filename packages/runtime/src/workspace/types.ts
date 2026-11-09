export type WorkspaceErrorCode =
  | 'workspace_unavailable'
  | 'workspace_changed'
  | 'invalid_path'
  | 'outside_workspace'
  | 'symlink_disallowed'
  | 'not_found'
  | 'not_directory'
  | 'already_exists'
  | 'unsupported_resource'
  | 'resource_unavailable';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface Workspace {
  readonly selectedPath: string;
  readonly rootPath: string;
  readonly identity: WorkspaceIdentity;
}

export interface ExistingWorkspaceResource {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
}

export interface NewWorkspaceFileTarget {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: 'missing';
}
