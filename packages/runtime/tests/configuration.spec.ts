import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeRuntimeConfiguration,
  createWorkspace,
  evaluateWorkspacePolicy,
  loadRuntimeConfiguration,
  parseRuntimeConfiguration,
} from '../src/index.js';

describe('YAML configuration validation', () => {
  it('parses a versioned configuration', () => {
    const result = parseRuntimeConfiguration(
      'user.yaml',
      [
        'schema: 1',
        'defaults:',
        '  mode: workspace_write',
        'policy:',
        '  actions:',
        '    fs.write: ask',
      ].join('\n'),
    );

    expect(result.mode).toBe('workspace_write');
    expect(result.actions['fs.write']).toBe('ask');
  });

  it('rejects duplicate YAML keys', () => {
    expect(() =>
      parseRuntimeConfiguration(
        'duplicate.yaml',
        [
          'schema: 1',
          'policy:',
          '  actions:',
          '    fs.read: allow',
          '    fs.read: deny',
        ].join('\n'),
      ),
    ).toThrow(/duplicate.yaml/);
  });

  it('rejects unsupported settings and versions', () => {
    expect(() => parseRuntimeConfiguration('future.yaml', 'schema: 2')).toThrow(
      /schema/,
    );

    expect(() =>
      parseRuntimeConfiguration(
        'unsafe.yaml',
        'schema: 1\nextensions:\n  autoLoad: true',
      ),
    ).toThrow(/extensions/);
  });

  it('does not elevate authority through workspace rules', () => {
    const user = parseRuntimeConfiguration(
      'user.yaml',
      [
        'schema: 1',
        'defaults:',
        '  mode: workspace_write',
        'policy:',
        '  actions:',
        '    fs.write: deny',
      ].join('\n'),
    );

    const project = parseRuntimeConfiguration(
      'project.yaml',
      ['schema: 1', 'policy:', '  actions:', '    fs.write: allow'].join('\n'),
    );

    const policy = composeRuntimeConfiguration(user, project);

    const decision = evaluateWorkspacePolicy(policy, {
      action: 'fs.write',
      relativePath: 'src/main.ts',
      kind: 'file',
    });

    expect(decision).toMatchObject({
      decision: 'deny',
      reason: 'user_ceiling',
    });
  });

  it('rejects workspace mode elevation', () => {
    const project = parseRuntimeConfiguration(
      'project.yaml',
      'schema: 1\ndefaults:\n  mode: workspace_write',
    );

    expect(() => composeRuntimeConfiguration(undefined, project)).toThrow(
      /cannot elevate/,
    );
  });
});

describe('configuration loading and trust', () => {
  let sandbox: string;

  afterEach(async () => {
    if (sandbox !== undefined) {
      await rm(sandbox, {
        recursive: true,
        force: true,
      });
    }
  });

  it('does not apply untrusted project configuration', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-config-'));

    await mkdir(join(sandbox, '.russet'));

    await writeFile(
      join(sandbox, '.russet/project.yaml'),
      ['schema: 1', 'policy:', '  actions:', '    fs.read: deny'].join('\n'),
    );

    const workspace = await createWorkspace(sandbox);

    const untrusted = await loadRuntimeConfiguration({
      workspace,
    });

    expect(untrusted.sources).toContainEqual({
      path: '.russet/project.yaml',
      status: 'ignored_untrusted',
    });

    const trusted = await loadRuntimeConfiguration({
      workspace,
      workspaceTrusted: true,
    });

    expect(trusted.sources).toContainEqual({
      path: '.russet/project.yaml',
      status: 'applied',
    });

    expect(
      evaluateWorkspacePolicy(trusted.policy, {
        action: 'fs.read',
        relativePath: 'src/main.ts',
        kind: 'file',
      }).decision,
    ).toBe('deny');
  });
});
