import { protectedResourceRule } from './protected.js';
import { WORKSPACE_ACTIONS } from './types.js';
import type {
  Permission,
  PermissionRules,
  PolicyEvaluation,
  PolicyRequest,
  WorkspaceAction,
  WorkspaceMode,
  WorkspacePolicy,
  WorkspacePolicyOptions,
  WorkspaceResourceKind,
} from './types.js';

const DEFAULT_USER_CEILING: Readonly<Record<WorkspaceAction, Permission>> = {
  'fs.read': 'allow',
  'fs.search': 'allow',
  'fs.write': 'allow',
  'fs.delete': 'ask',
  'process.execute': 'deny',
};

const DEFAULT_WORKSPACE_RESTRICTIONS: Readonly<
  Record<WorkspaceAction, Permission>
> = {
  'fs.read': 'allow',
  'fs.search': 'allow',
  'fs.write': 'allow',
  'fs.delete': 'allow',
  'process.execute': 'allow',
};

const MODE_RESTRICTIONS: Readonly<
  Record<WorkspaceMode, Readonly<Record<WorkspaceAction, Permission>>>
> = {
  read_only: {
    'fs.read': 'allow',
    'fs.search': 'allow',
    'fs.write': 'deny',
    'fs.delete': 'deny',
    'process.execute': 'deny',
  },

  workspace_write: {
    'fs.read': 'allow',
    'fs.search': 'allow',
    'fs.write': 'allow',
    'fs.delete': 'ask',
    'process.execute': 'ask',
  },
};

function isAction(value: unknown): value is WorkspaceAction {
  return (
    typeof value === 'string' &&
    WORKSPACE_ACTIONS.some((action) => action === value)
  );
}

function isPermission(value: unknown): value is Permission {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function mergeRules(
  defaults: Readonly<Record<WorkspaceAction, Permission>>,
  overrides: PermissionRules | undefined,
): Readonly<Record<WorkspaceAction, Permission>> {
  const result = { ...defaults };

  for (const [action, decision] of Object.entries(overrides ?? {})) {
    if (!isAction(action) || !isPermission(decision)) {
      throw new TypeError(`Invalid workspace policy rule: ${action}`);
    }

    result[action] = decision;
  }

  return Object.freeze(result);
}

export function createWorkspacePolicy(
  options: WorkspacePolicyOptions,
): WorkspacePolicy {
  if (options.mode !== 'read_only' && options.mode !== 'workspace_write') {
    throw new TypeError('Invalid workspace mode.');
  }

  return Object.freeze({
    mode: options.mode,

    userCeiling: mergeRules(DEFAULT_USER_CEILING, options.userCeiling),

    workspaceRestrictions: mergeRules(
      DEFAULT_WORKSPACE_RESTRICTIONS,
      options.workspaceRestrictions,
    ),
  });
}

function isNormalizedRelativePath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    path.includes('\\')
  ) {
    return false;
  }

  if (path === '.') {
    return true;
  }

  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return false;
  }

  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

function isResourceKind(value: unknown): value is WorkspaceResourceKind {
  return value === 'file' || value === 'directory' || value === 'missing';
}

function invalidRequest(): PolicyEvaluation {
  return {
    decision: 'deny',
    reason: 'invalid_request',
  };
}

export function evaluateWorkspacePolicy(
  policy: WorkspacePolicy,
  request: PolicyRequest,
): PolicyEvaluation {
  if (!isAction(request.action)) {
    return invalidRequest();
  }

  if (policy.mode !== 'read_only' && policy.mode !== 'workspace_write') {
    return invalidRequest();
  }

  if (request.action !== 'process.execute') {
    if (!('relativePath' in request) || !('kind' in request)) {
      return invalidRequest();
    }

    const { relativePath, kind } = request;

    if (!isNormalizedRelativePath(relativePath) || !isResourceKind(kind)) {
      return invalidRequest();
    }

    if (
      (request.action === 'fs.read' && kind !== 'file') ||
      (request.action === 'fs.search' && kind === 'missing') ||
      (request.action === 'fs.write' && kind === 'directory') ||
      (request.action === 'fs.delete' && kind === 'missing')
    ) {
      return invalidRequest();
    }

    const ruleId = protectedResourceRule(request.action, relativePath, kind);

    if (ruleId !== undefined) {
      return {
        decision: 'deny',
        reason: 'protected_resource',
        ruleId,
      };
    }
  }

  const layers = [
    ['user_ceiling', policy.userCeiling[request.action]],
    ['operating_mode', MODE_RESTRICTIONS[policy.mode][request.action]],
    ['workspace_restriction', policy.workspaceRestrictions[request.action]],
  ] as const;

  for (const decision of ['deny', 'ask'] as const) {
    for (const [reason, value] of layers) {
      if (!isPermission(value)) {
        return invalidRequest();
      }

      if (value === decision) {
        return { decision, reason };
      }
    }
  }

  return {
    decision: 'allow',
    reason: 'permitted',
  };
}
