import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkspace,
  createWorkspacePolicy,
  loadWorkspaceInstructions,
} from '../src/index.js';
import type { Workspace, WorkspacePolicy } from '../src/index.js';

let sandbox: string;
let root: string;
let workspace: Workspace;
let policy: WorkspacePolicy;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-instructions-'));

  root = join(sandbox, 'workspace');

  await mkdir(join(root, 'packages/ai/src'), {
    recursive: true,
  });

  await mkdir(join(root, 'packages/agent'), {
    recursive: true,
  });

  await writeFile(join(root, 'packages/ai/src/main.ts'), 'export {};');

  workspace = await createWorkspace(root);
  policy = createWorkspacePolicy({ mode: 'read_only' });
});

afterEach(async () => {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
});

const target = {
  kind: 'file' as const,
  path: 'packages/ai/src/main.ts',
};

describe('AGENTS.md discovery', () => {
  it('loads root and applicable nested instructions in order', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root guidance');
    await writeFile(join(root, 'packages/AGENTS.md'), 'Package guidance');
    await writeFile(join(root, 'packages/ai/AGENTS.md'), 'AI guidance');
    await writeFile(
      join(root, 'packages/agent/AGENTS.md'),
      'Unrelated guidance',
    );

    const result = await loadWorkspaceInstructions(workspace, policy, target);

    expect(result.sources.map((source) => source.path)).toEqual([
      'AGENTS.md',
      'packages/AGENTS.md',
      'packages/ai/AGENTS.md',
    ]);

    expect(result.sources.map((source) => source.scope)).toEqual([
      '.',
      'packages',
      'packages/ai',
    ]);

    expect(result.sources.map((source) => source.content)).toEqual([
      'Root guidance',
      'Package guidance',
      'AI guidance',
    ]);
  });

  it('does not discover instructions outside the workspace', async () => {
    await writeFile(join(sandbox, 'AGENTS.md'), 'Parent instructions');

    const result = await loadWorkspaceInstructions(workspace, policy, target);

    expect(result.sources).toHaveLength(0);
  });

  it('supports prospective new file targets', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root');
    await writeFile(join(root, 'packages/ai/AGENTS.md'), 'AI');

    const result = await loadWorkspaceInstructions(workspace, policy, {
      kind: 'new_file',
      path: 'packages/ai/src/new.ts',
    });

    expect(result.sources.map((source) => source.scope)).toEqual([
      '.',
      'packages/ai',
    ]);
  });

  it('ignores empty instruction files', async () => {
    await writeFile(join(root, 'AGENTS.md'), ' \n\t ');

    const result = await loadWorkspaceInstructions(workspace, policy, target);

    expect(result.sources).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
  });

  it('provides stable revisions and detects changes', async () => {
    const path = join(root, 'AGENTS.md');

    await writeFile(path, 'Original guidance');

    const first = await loadWorkspaceInstructions(workspace, policy, target);

    const second = await loadWorkspaceInstructions(workspace, policy, target);

    expect(first.revision).toBe(second.revision);
    expect(first.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.sources[0])).toBe(true);

    await writeFile(path, 'Updated guidance');

    const updated = await loadWorkspaceInstructions(workspace, policy, target);

    expect(updated.revision).not.toBe(first.revision);
    expect(updated.sources[0]?.content).toBe('Updated guidance');
  });

  it('rejects symlinked instruction files', async () => {
    await writeFile(join(sandbox, 'outside.md'), 'Outside guidance');

    await symlink(join(sandbox, 'outside.md'), join(root, 'AGENTS.md'));

    await expect(
      loadWorkspaceInstructions(workspace, policy, target),
    ).rejects.toMatchObject({
      code: 'symlink_disallowed',
    });
  });

  it('rejects targets outside the workspace', async () => {
    await expect(
      loadWorkspaceInstructions(workspace, policy, {
        kind: 'directory',
        path: '../outside',
      }),
    ).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });

  it('does not bypass workspace read restrictions', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Instructions');

    const deniedPolicy = createWorkspacePolicy({
      mode: 'read_only',
      userCeiling: {
        'fs.read': 'deny',
      },
    });

    await expect(
      loadWorkspaceInstructions(workspace, deniedPolicy, target),
    ).rejects.toMatchObject({
      code: 'not_permitted',
    });

    const approvalRequired = createWorkspacePolicy({
      mode: 'read_only',
      userCeiling: {
        'fs.read': 'ask',
      },
    });

    await expect(
      loadWorkspaceInstructions(workspace, approvalRequired, target),
    ).rejects.toMatchObject({
      code: 'not_permitted',
    });
  });

  it('rejects protected instruction sources', async () => {
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git/AGENTS.md'), 'Protected');
    await writeFile(join(root, '.git/config'), 'config');

    await expect(
      loadWorkspaceInstructions(workspace, policy, {
        kind: 'file',
        path: '.git/config',
      }),
    ).rejects.toMatchObject({
      code: 'not_permitted',
    });
  });

  it('rejects oversized instruction files', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(32 * 1024 + 1));

    await expect(
      loadWorkspaceInstructions(workspace, policy, target),
    ).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('rejects invalid UTF-8 and NUL content', async () => {
    const path = join(root, 'AGENTS.md');

    await writeFile(path, Buffer.from([0xff, 0xfe]));

    await expect(
      loadWorkspaceInstructions(workspace, policy, target),
    ).rejects.toMatchObject({
      code: 'invalid_encoding',
    });

    await writeFile(path, 'Valid\0Invalid');

    await expect(
      loadWorkspaceInstructions(workspace, policy, target),
    ).rejects.toMatchObject({
      code: 'invalid_encoding',
    });
  });

  it('rejects an instruction source that is a directory', async () => {
    await mkdir(join(root, 'AGENTS.md'));

    await expect(
      loadWorkspaceInstructions(workspace, policy, target),
    ).rejects.toMatchObject({
      code: 'source_unavailable',
    });
  });

  it('enforces the combined instruction budget', async () => {
    const content = 'x'.repeat(30 * 1024);

    await mkdir(join(root, 'a/b/c'), {
      recursive: true,
    });

    for (const scope of ['.', 'a', 'a/b', 'a/b/c']) {
      const path =
        scope === '.'
          ? join(root, 'AGENTS.md')
          : join(root, scope, 'AGENTS.md');

      await writeFile(path, content);
    }

    await expect(
      loadWorkspaceInstructions(workspace, policy, {
        kind: 'directory',
        path: 'a/b/c',
      }),
    ).rejects.toMatchObject({
      code: 'total_budget_exceeded',
    });
  });

  it('enforces the instruction source count', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'root');

    const segments = Array.from({ length: 16 }, (_, index) => `d${index}`);

    let directory = root;

    for (const segment of segments) {
      directory = join(directory, segment);

      await mkdir(directory);
      await writeFile(join(directory, 'AGENTS.md'), 'guidance');
    }

    await expect(
      loadWorkspaceInstructions(workspace, policy, {
        kind: 'directory',
        path: segments.join('/'),
      }),
    ).rejects.toMatchObject({
      code: 'too_many_sources',
    });
  });
});
