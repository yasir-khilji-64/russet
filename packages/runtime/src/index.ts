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

export {
  createWorkspacePolicy,
  evaluateWorkspacePolicy,
} from './policy/evaluate.js';
export type {
  Permission,
  PermissionRules,
  PolicyEvaluation,
  PolicyReason,
  PolicyRequest,
  WorkspaceAction,
  WorkspaceFileAction,
  WorkspaceMode,
  WorkspacePolicy,
  WorkspacePolicyOptions,
  WorkspaceResourceKind,
} from './policy/types.js';

export type {
  ApprovalBroker,
  ApprovalOutcome,
  ApprovalRequest,
} from './approvals/once.js';

export { loadWorkspaceInstructions } from './context/instructions.js';

export { ContextAssemblyError } from './context/assemble.js';
export type { ContextAssemblyErrorCode } from './context/assemble.js';

export { createMutationContextGuard } from './context/mutation.js';
export type {
  MutationContextGuard,
  MutationContextGuardOptions,
} from './context/mutation.js';

export { createWorkspaceContext } from './context/provider.js';
export type {
  ContextSourceSummary,
  WorkspaceContext,
  WorkspaceContextOptions,
  WorkspaceContextSnapshot,
} from './context/provider.js';

export { createContextRelevanceTracker } from './context/relevance.js';

export { InstructionLoadError } from './context/types.js';
export type {
  InstructionErrorCode,
  InstructionSource,
  InstructionTarget,
  WorkspaceInstructions,
} from './context/types.js';

export { createToolRegistry, defineRuntimeTool } from './tools/registry.js';

export { createRuntimeGateway } from './tools/gateway.js';
export type { RuntimeGatewayOptions } from './tools/gateway.js';

export { createManagedReadTools } from './tools/builtins/index.js';
export type { ManagedReadToolsOptions } from './tools/builtins/index.js';
export { createManagedWriteTools } from './tools/builtins/write.js';
export type { ManagedWriteToolsOptions } from './tools/builtins/write.js';

export type {
  RegisteredRuntimeTool,
  RuntimeTool,
  RuntimeToolContext,
  RuntimeToolRegistry,
  RuntimeToolTarget,
} from './tools/types.js';

export { activateTrustedExtensions } from './extensions/host.js';

export { RUSSET_EXTENSION_API_VERSION } from './extensions/types.js';
export type {
  ExtensionContext,
  ExtensionHost,
  RussetExtension,
} from './extensions/types.js';

export {
  composeRuntimeConfiguration,
  parseRuntimeConfiguration,
} from './config/configuration.js';
export type { RuntimeConfiguration } from './config/configuration.js';

export { loadRuntimeConfiguration } from './config/load.js';
export type {
  ConfigurationSourceStatus,
  LoadedRuntimeConfiguration,
  RuntimeConfigurationLoadOptions,
} from './config/load.js';
