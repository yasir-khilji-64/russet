import { parseDocument } from 'yaml';

import { createWorkspacePolicy } from '../policy/evaluate.js';
import { WORKSPACE_ACTIONS } from '../policy/types.js';
import type {
  Permission,
  PermissionRules,
  WorkspaceAction,
  WorkspaceMode,
  WorkspacePolicy,
} from '../policy/types.js';

export interface RuntimeConfiguration {
  readonly mode?: WorkspaceMode;
  readonly actions: PermissionRules;
}

export class RuntimeConfigurationError extends Error {
  constructor(
    readonly source: string,
    readonly setting: string,
    message: string,
  ) {
    super(`${source} (${setting}): ${message}`);
    this.name = 'RuntimeConfigurationError';
  }
}

function record(
  value: unknown,
  source: string,
  setting: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeConfigurationError(source, setting, 'Expected a mapping.');
  }

  return value as Record<string, unknown>;
}

function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
  setting: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RuntimeConfigurationError(
        source,
        `${setting}.${key}`,
        'Unknown configuration setting.',
      );
    }
  }
}

function isMode(value: unknown): value is WorkspaceMode {
  return value === 'read_only' || value === 'workspace_write';
}

function isPermission(value: unknown): value is Permission {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function isAction(value: string): value is WorkspaceAction {
  return WORKSPACE_ACTIONS.some((action) => action === value);
}

export function parseRuntimeConfiguration(
  source: string,
  text: string,
): RuntimeConfiguration {
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) {
    throw new RuntimeConfigurationError(
      source,
      '$',
      'Configuration exceeds 32 KiB.',
    );
  }

  let raw: unknown;

  try {
    const document = parseDocument(text, {
      version: '1.2',
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      merge: false,
      resolveKnownTags: false,
    });

    const problem = document.errors[0] ?? document.warnings[0];

    if (problem !== undefined) {
      throw problem;
    }

    // No aliases, so configuration cannot use alias expansion.
    raw = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new RuntimeConfigurationError(
      source,
      '$',
      error instanceof Error ? error.message : 'Invalid YAML document.',
    );
  }

  const root = record(raw, source, '$');

  knownKeys(root, ['schema', 'defaults', 'policy'], source, '$');

  if (root.schema !== 1) {
    throw new RuntimeConfigurationError(
      source,
      'schema',
      'Expected schema version 1.',
    );
  }

  let mode: WorkspaceMode | undefined;

  if (root.defaults !== undefined) {
    const defaults = record(root.defaults, source, 'defaults');

    knownKeys(defaults, ['mode'], source, 'defaults');

    if (defaults.mode !== undefined && !isMode(defaults.mode)) {
      throw new RuntimeConfigurationError(
        source,
        'defaults.mode',
        'Invalid operating mode.',
      );
    }

    mode = defaults.mode;
  }

  const actions: Partial<Record<WorkspaceAction, Permission>> = {};

  if (root.policy !== undefined) {
    const policy = record(root.policy, source, 'policy');

    knownKeys(policy, ['actions'], source, 'policy');

    if (policy.actions !== undefined) {
      const configured = record(policy.actions, source, 'policy.actions');

      for (const [action, permission] of Object.entries(configured)) {
        if (!isAction(action) || !isPermission(permission)) {
          throw new RuntimeConfigurationError(
            source,
            `policy.actions.${action}`,
            'Invalid action or permission.',
          );
        }

        actions[action] = permission;
      }
    }
  }

  return Object.freeze({
    ...(mode === undefined ? {} : { mode }),
    actions: Object.freeze(actions),
  });
}

/**
 * Compose trusted user settings with additional workspace restrictions.
 *
 * This does not resolve approvals or execute operations.
 */
export function composeRuntimeConfiguration(
  user?: RuntimeConfiguration,
  workspace?: RuntimeConfiguration,
): WorkspacePolicy {
  const userMode = user?.mode ?? 'read_only';

  if (workspace?.mode === 'workspace_write' && userMode === 'read_only') {
    throw new RuntimeConfigurationError(
      '.russet/project.yaml',
      'defaults.mode',
      'Workspace configuration cannot elevate the user mode.',
    );
  }

  const mode: WorkspaceMode =
    workspace?.mode === 'read_only' ? 'read_only' : userMode;

  return createWorkspacePolicy({
    mode,
    ...(user === undefined ? {} : { userCeiling: user.actions }),
    ...(workspace === undefined
      ? {}
      : { workspaceRestrictions: workspace.actions }),
  });
}
