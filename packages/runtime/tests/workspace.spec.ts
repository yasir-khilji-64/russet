import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertWorkspaceIdentity,
  createWorkspace,
  resolveExistingWorkspacePath,
  resolveNewWorkspaceFilePath,
} from '../src/index.js';

let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-workspace-'));

  root = join(sandbox, 'project');
  outside = join(sandbox, 'other');

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside);

  await writeFile(join(root, 'src', 'main.ts'), 'export {};');
});

afterEach(async () => {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
});

describe('workspace identity', () => {
  it('canonicalizes and identifies the selected root', async () => {
    const workspace = await createWorkspace(root);

    expect(workspace.selectedPath).toBe(root);
    expect(workspace.rootPath).toBe(await realpath(root));
    expect(workspace.identity.device).toMatch(/^\d+$/);
    expect(workspace.identity.inode).toMatch(/^\d+$/);

    await expect(assertWorkspaceIdentity(workspace)).resolves.toBeUndefined();
  });

  it('does not require Git', async () => {
    const workspace = await createWorkspace(root);

    expect(workspace.rootPath).toBe(root);
  });

  it('rejects invalid workspace roots', async () => {
    await expect(
      createWorkspace(join(sandbox, 'missing')),
    ).rejects.toMatchObject({
      code: 'workspace_unavailable',
    });

    await expect(
      createWorkspace(join(root, 'src', 'main.ts')),
    ).rejects.toMatchObject({
      code: 'workspace_unavailable',
    });
  });

  it('detects replacement of the root', async () => {
    const workspace = await createWorkspace(root);

    await rename(root, join(sandbox, 'old-project'));
    await mkdir(root);

    await expect(assertWorkspaceIdentity(workspace)).rejects.toMatchObject({
      code: 'workspace_changed',
    });
  });

  it('detects retargeting of a selected root symlink', async () => {
    const alias = join(sandbox, 'alias');

    await symlink(root, alias);

    const workspace = await createWorkspace(alias);

    expect(workspace.rootPath).toBe(root);

    await rm(alias);
    await symlink(outside, alias);

    await expect(assertWorkspaceIdentity(workspace)).rejects.toMatchObject({
      code: 'workspace_changed',
    });
  });
});

describe('workspace resource resolution', () => {
  it('resolves ordinary files and directories', async () => {
    const workspace = await createWorkspace(root);

    await expect(
      resolveExistingWorkspacePath(workspace, '.'),
    ).resolves.toMatchObject({
      relativePath: '.',
      kind: 'directory',
    });

    await expect(
      resolveExistingWorkspacePath(workspace, 'src/main.ts'),
    ).resolves.toEqual({
      absolutePath: join(root, 'src', 'main.ts'),
      relativePath: join('src', 'main.ts'),
      kind: 'file',
    });
  });

  it('rejects absolute and traversal paths', async () => {
    const workspace = await createWorkspace(root);

    const paths = ['../other', 'src/../src/main.ts', '/etc/passwd', 'C:\\temp'];

    for (const input of paths) {
      await expect(
        resolveExistingWorkspacePath(workspace, input),
      ).rejects.toMatchObject({
        code: 'outside_workspace',
      });
    }
  });

  it('rejects malformed relative paths', async () => {
    const workspace = await createWorkspace(root);

    for (const input of ['', 'src\\main.ts', 'src/\0file']) {
      await expect(
        resolveExistingWorkspacePath(workspace, input),
      ).rejects.toMatchObject({
        code: 'invalid_path',
      });
    }
  });

  it('rejects final and intermediate symlinks', async () => {
    const workspace = await createWorkspace(root);

    await symlink(outside, join(root, 'linked'));
    await symlink('src/main.ts', join(root, 'file-link'));

    for (const input of ['linked', 'linked/main.ts', 'file-link']) {
      await expect(
        resolveExistingWorkspacePath(workspace, input),
      ).rejects.toMatchObject({
        code: 'symlink_disallowed',
      });
    }
  });

  it('validates new file targets', async () => {
    const workspace = await createWorkspace(root);

    await expect(
      resolveNewWorkspaceFilePath(workspace, 'src/next.ts'),
    ).resolves.toEqual({
      absolutePath: join(root, 'src', 'next.ts'),
      relativePath: join('src', 'next.ts'),
      kind: 'missing',
    });

    await expect(
      resolveNewWorkspaceFilePath(workspace, 'src/main.ts'),
    ).rejects.toMatchObject({
      code: 'already_exists',
    });

    await expect(
      resolveNewWorkspaceFilePath(workspace, 'missing/next.ts'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects creation through symlinked parents', async () => {
    const workspace = await createWorkspace(root);

    await symlink(outside, join(root, 'linked'));

    await expect(
      resolveNewWorkspaceFilePath(workspace, 'linked/next.ts'),
    ).rejects.toMatchObject({
      code: 'symlink_disallowed',
    });
  });
});
