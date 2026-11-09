import { describe, expect, it } from 'vitest';

import {
  createWorkspacePolicy,
  evaluateWorkspacePolicy,
} from '../src/index.js';

type FileAction = 'fs.read' | 'fs.search' | 'fs.write' | 'fs.delete';

function file(action: FileAction, relativePath: string) {
  return {
    action,
    relativePath,
    kind: 'file' as const,
  };
}

describe('workspace policy and modes', () => {
  it('allows exploration in read-only mode', () => {
    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.read', 'src/a.ts')).decision,
    ).toBe('allow');

    expect(
      evaluateWorkspacePolicy(policy, {
        action: 'fs.search',
        relativePath: '.',
        kind: 'directory',
      }).decision,
    ).toBe('allow');
  });

  it('blocks modifications in read-only mode', () => {
    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.write', 'src/a.ts')),
    ).toMatchObject({
      decision: 'deny',
      reason: 'operating_mode',
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.delete', 'src/a.ts')).decision,
    ).toBe('deny');
  });

  it('allows writes and asks for deletion', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.write', 'src/a.ts')).decision,
    ).toBe('allow');

    expect(
      evaluateWorkspacePolicy(policy, {
        action: 'fs.write',
        relativePath: 'src/new.ts',
        kind: 'missing',
      }).decision,
    ).toBe('allow');

    expect(
      evaluateWorkspacePolicy(policy, file('fs.delete', 'src/a.ts')),
    ).toMatchObject({
      decision: 'ask',
      reason: 'user_ceiling',
    });
  });

  it('denies process execution by default', () => {
    for (const mode of ['read_only', 'workspace_write'] as const) {
      const policy = createWorkspacePolicy({ mode });

      expect(
        evaluateWorkspacePolicy(policy, {
          action: 'process.execute',
        }).decision,
      ).toBe('deny');
    }
  });

  it('does not allow workspace rules to elevate authority', () => {
    const userLimited = createWorkspacePolicy({
      mode: 'workspace_write',
      userCeiling: {
        'fs.write': 'ask',
      },
      workspaceRestrictions: {
        'fs.write': 'allow',
      },
    });

    expect(
      evaluateWorkspacePolicy(userLimited, file('fs.write', 'src/a.ts')),
    ).toMatchObject({
      decision: 'ask',
      reason: 'user_ceiling',
    });

    const modeLimited = createWorkspacePolicy({
      mode: 'read_only',
      workspaceRestrictions: {
        'fs.write': 'allow',
      },
    });

    expect(
      evaluateWorkspacePolicy(modeLimited, file('fs.write', 'src/a.ts')),
    ).toMatchObject({
      decision: 'deny',
      reason: 'operating_mode',
    });
  });

  it('supports additional workspace restrictions', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.write': 'deny',
        'fs.read': 'ask',
      },
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.write', 'src/a.ts')),
    ).toMatchObject({
      decision: 'deny',
      reason: 'workspace_restriction',
    });

    expect(
      evaluateWorkspacePolicy(policy, file('fs.read', 'src/a.ts')),
    ).toMatchObject({
      decision: 'ask',
      reason: 'workspace_restriction',
    });
  });

  it('allows only a trusted ceiling to enable command approval', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      userCeiling: {
        'process.execute': 'allow',
      },
    });

    expect(
      evaluateWorkspacePolicy(policy, {
        action: 'process.execute',
      }),
    ).toMatchObject({
      decision: 'ask',
      reason: 'operating_mode',
    });
  });

  it('hard-denies protected resource access', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const protectedPaths = [
      '.env',
      'src/.env.local',
      'src/.ENV',
      'ssl/cert.pem',
      'ssl/private.key',
      'packages/a/.git/config',
    ];

    for (const path of protectedPaths) {
      expect(
        evaluateWorkspacePolicy(policy, file('fs.read', path)),
      ).toMatchObject({
        decision: 'deny',
        reason: 'protected_resource',
      });
    }
  });

  it('protects metadata from mutation', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const protectedPaths = [
      '.gitignore',
      '.gitattributes',
      '.gitmodules',
      '.russet/project.yaml',
      '.russet/extensions/custom.ts',
    ];

    for (const path of protectedPaths) {
      expect(
        evaluateWorkspacePolicy(policy, file('fs.write', path)),
      ).toMatchObject({
        decision: 'deny',
        reason: 'protected_resource',
      });
    }

    expect(
      evaluateWorkspacePolicy(policy, file('fs.read', '.gitignore')).decision,
    ).toBe('allow');
  });

  it('blocks directory deletion', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    expect(
      evaluateWorkspacePolicy(policy, {
        action: 'fs.delete',
        relativePath: 'src',
        kind: 'directory',
      }),
    ).toMatchObject({
      decision: 'deny',
      ruleId: 'workspace.directory_delete',
    });

    expect(
      evaluateWorkspacePolicy(policy, {
        action: 'fs.delete',
        relativePath: '.',
        kind: 'directory',
      }),
    ).toMatchObject({
      decision: 'deny',
      ruleId: 'workspace.root',
    });
  });

  it('fails closed on invalid paths', () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const invalidPaths = [
      '/tmp/outside',
      '../outside',
      'src/../outside',
      'src\\file',
      'src//file',
      'C:/outside',
      '',
    ];

    for (const path of invalidPaths) {
      expect(
        evaluateWorkspacePolicy(policy, file('fs.read', path)),
      ).toMatchObject({
        decision: 'deny',
        reason: 'invalid_request',
      });
    }
  });

  it('creates an immutable policy snapshot', () => {
    const restrictions: {
      'fs.read': 'allow' | 'deny';
    } = {
      'fs.read': 'deny',
    };

    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: restrictions,
    });

    restrictions['fs.read'] = 'allow';

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.workspaceRestrictions)).toBe(true);

    expect(
      evaluateWorkspacePolicy(policy, file('fs.read', 'src/a.ts')).decision,
    ).toBe('deny');
  });

  it('rejects invalid policy configuration', () => {
    expect(() =>
      createWorkspacePolicy({
        mode: 'invalid' as 'read_only',
      }),
    ).toThrow(TypeError);

    expect(() =>
      createWorkspacePolicy({
        mode: 'read_only',
        userCeiling: {
          'fs.write': 'bypass' as 'allow',
        },
      }),
    ).toThrow(TypeError);
  });
});
