export const WORKSPACE_ACTIONS = [
  'fs.read',
  'fs.search',
  'fs.write',
  'fs.delete',
  'process.execute',
] as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export type WorkspaceFileAction = Exclude<WorkspaceAction, 'process.execute'>;

export type WorkspaceMode = 'read_only' | 'workspace_write';

export type Permission = 'allow' | 'ask' | 'deny';

export type WorkspaceResourceKind = 'file' | 'directory' | 'missing';

export type PolicyRequest =
  | {
      readonly action: WorkspaceFileAction;
      readonly relativePath: string;
      readonly kind: WorkspaceResourceKind;
    }
  | {
      readonly action: 'process.execute';
    };

export type PermissionRules = Readonly<
  Partial<Record<WorkspaceAction, Permission>>
>;

export interface WorkspacePolicyOptions {
  readonly mode: WorkspaceMode;
  readonly userCeiling?: PermissionRules;
  readonly workspaceRestrictions?: PermissionRules;
}

export interface WorkspacePolicy {
  readonly mode: WorkspaceMode;
  readonly userCeiling: Readonly<Record<WorkspaceAction, Permission>>;
  readonly workspaceRestrictions: Readonly<Record<WorkspaceAction, Permission>>;
}

export type PolicyReason =
  | 'invalid_request'
  | 'protected_resource'
  | 'user_ceiling'
  | 'operating_mode'
  | 'workspace_restriction'
  | 'permitted';

export interface PolicyEvaluation {
  readonly decision: Permission;
  readonly reason: PolicyReason;
  readonly ruleId?: string;
}
