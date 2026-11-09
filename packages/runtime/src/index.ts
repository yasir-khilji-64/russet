export {
  assertWorkspaceIdentity,
  createWorkspace,
} from './workspace/workspace.js';

export {
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from './workspace/paths.js';

export { WorkspaceError } from './workspace/types.js';
export type {
  ExistingWorkspaceResource,
  NewWorkspaceFileTarget,
  Workspace,
  WorkspaceErrorCode,
  WorkspaceIdentity,
} from './workspace/types.js';
