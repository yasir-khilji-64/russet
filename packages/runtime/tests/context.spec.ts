import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkspace,
  createWorkspaceContext,
  createWorkspacePolicy,
} from '../src/index.js';
import type {
  Workspace,
  WorkspaceContext,
  WorkspacePolicy,
} from '../src/index.js';

let sandbox: string;
let root: string;
let workspace: Workspace;
let policy: WorkspacePolicy;
let context: WorkspaceContext;

const request = () => ({
  runId: 'test-run',
  modelRequestOrdinal: 1,
  model: {
    providerId: 'test',
    modelId: 'test-model',
  },
  conversation: [],
  signal: new AbortController().signal,
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-context-'));

  root = join(sandbox, 'workspace');

  await mkdir(join(root, 'packages/ai/src'), {
    recursive: true,
  });

  await mkdir(join(root, 'packages/agent/src'), {
    recursive: true,
  });

  await writeFile(join(root, 'packages/ai/src/main.ts'), 'export {};');

  await writeFile(join(root, 'packages/agent/src/main.ts'), 'export {};');

  workspace = await createWorkspace(root);
  policy = createWorkspacePolicy({
    mode: 'read_only',
  });

  context = createWorkspaceContext({
    workspace,
    policy,
  });
});

afterEach(async () => {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
});

describe('workspace context assembly', () => {
  it('loads root instructions by default', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root guidance');

    await writeFile(join(root, 'packages/ai/AGENTS.md'), 'AI guidance');

    const prepared = await context.prepare(request());

    expect(prepared.instructions).toContain('Root guidance');

    expect(prepared.instructions).not.toContain('AI guidance');

    expect(context.inspectLastPrepared()?.sources).toHaveLength(1);
  });

  it('loads relevant nested instructions in scope order', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root');

    await writeFile(join(root, 'packages/ai/AGENTS.md'), 'AI');

    await writeFile(join(root, 'packages/agent/AGENTS.md'), 'Agent');

    context.setRelevantTargets([
      {
        kind: 'file',
        path: 'packages/agent/src/main.ts',
      },
      {
        kind: 'file',
        path: 'packages/ai/src/main.ts',
      },
    ]);

    const prepared = await context.prepare(request());
    const snapshot = context.inspectLastPrepared();

    expect(snapshot?.sources.map((source) => source.path)).toEqual([
      'AGENTS.md',
      'packages/agent/AGENTS.md',
      'packages/ai/AGENTS.md',
    ]);

    expect(prepared.instructions.match(/source="AGENTS.md"/g)).toHaveLength(1);

    expect(prepared.instructions).toContain('scope="packages/ai"');

    expect(prepared.instructions).toContain('scope="packages/agent"');
  });

  it('preserves raw Markdown inside instruction scopes', async () => {
    const markdown = [
      '# Project conventions',
      '',
      '- Prefer `Map<string, number>`.',
      '',
      '```tsx',
      'const Button = () => <button>Save & Close</button>;',
      '```',
    ].join('\n');

    await writeFile(join(root, 'AGENTS.md'), markdown);

    const prepared = await context.prepare(request());

    expect(prepared.instructions).toContain(markdown);
    expect(prepared.instructions).toContain(
      '<instruction source="AGENTS.md" scope=".">',
    );
  });

  it('provides stable revisions and detects changes', async () => {
    const path = join(root, 'AGENTS.md');

    await writeFile(path, 'Original');

    const first = await context.prepare(request());
    const second = await context.prepare(request());

    expect(first.revision).toBe(second.revision);

    await writeFile(path, 'Updated');

    const third = await context.prepare(request());

    expect(third.revision).not.toBe(first.revision);
    expect(third.instructions).toContain('Updated');
  });

  it('changes the revision when target selection changes', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root');

    const rootOnly = await context.prepare(request());

    context.setRelevantTargets([
      {
        kind: 'file',
        path: 'packages/ai/src/main.ts',
      },
    ]);

    expect(context.inspectLastPrepared()).toBeUndefined();

    const targeted = await context.prepare(request());

    expect(targeted.revision).not.toBe(rootOnly.revision);
  });

  it('supports new-file context in write mode', async () => {
    const writeContext = createWorkspaceContext({
      workspace,
      policy: createWorkspacePolicy({
        mode: 'workspace_write',
      }),
    });

    await writeFile(join(root, 'packages/ai/AGENTS.md'), 'AI conventions');

    writeContext.setRelevantTargets([
      {
        kind: 'new_file',
        path: 'packages/ai/src/new.ts',
      },
    ]);

    const result = await writeContext.prepare(request());

    expect(result.instructions).toContain('AI conventions');
  });

  it('rejects protected or unauthorized targets', async () => {
    await mkdir(join(root, '.git'));

    await writeFile(join(root, '.git/config'), 'protected');

    context.setRelevantTargets([
      {
        kind: 'file',
        path: '.git/config',
      },
    ]);

    await expect(context.prepare(request())).rejects.toMatchObject({
      code: 'target_not_permitted',
    });
  });

  it('fails when rendered instructions exceed the budget', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Some instructions');

    const limited = createWorkspaceContext({
      workspace,
      policy,
      maxRenderedBytes: 64,
    });

    await expect(limited.prepare(request())).rejects.toMatchObject({
      code: 'render_budget_exceeded',
    });
  });

  it('rejects XML-incompatible instruction content', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Valid text\u0001Invalid control');

    await expect(context.prepare(request())).rejects.toMatchObject({
      code: 'invalid_content',
    });
  });

  it('does not prepare after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      context.prepare({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    expect(context.inspectLastPrepared()).toBeUndefined();
  });

  it('returns immutable diagnostic snapshots', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Root');

    await context.prepare(request());

    const snapshot = context.inspectLastPrepared();

    expect(snapshot).toBeDefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.sources)).toBe(true);
    expect(Object.isFrozen(snapshot?.targets)).toBe(true);
  });

  it('rejects invalid target selections', () => {
    const targets = Array.from({ length: 9 }, (_, index) => ({
      kind: 'directory' as const,
      path: `directory-${index}`,
    }));

    expect(() => context.setRelevantTargets(targets)).toThrow();

    expect(() =>
      createWorkspaceContext({
        workspace,
        policy,
        maxRenderedBytes: 0,
      }),
    ).toThrow();
  });
});
