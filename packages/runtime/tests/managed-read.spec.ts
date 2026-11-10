import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ToolExecutionGateway,
  ToolExecutionRequest,
  ToolExecutionResult,
} from '@russet/agent';

import {
  createContextRelevanceTracker,
  createManagedReadTools,
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspaceContext,
  createWorkspacePolicy,
} from '../src/index.js';
import type { Workspace, WorkspacePolicy } from '../src/index.js';

let sandbox: string;
let root: string;
let workspace: Workspace;
let policy: WorkspacePolicy;

function gateway(
  selectedPolicy: WorkspacePolicy = policy,
): ToolExecutionGateway {
  return createRuntimeGateway({
    workspace,
    policy: selectedPolicy,
    registry: createToolRegistry(
      createManagedReadTools({
        workspace,
        policy: selectedPolicy,
      }),
    ),
  });
}

function request(name: string, args: unknown): ToolExecutionRequest {
  return {
    runId: 'test-run',
    modelRequestId: 'test-model-request',
    toolExecutionId: 'test-execution',
    toolCall: {
      toolCallId: 'test-call',
      name,
      arguments: args,
    },
  };
}

async function execute(
  name: string,
  args: unknown,
  selectedPolicy = policy,
): Promise<ToolExecutionResult> {
  return gateway(selectedPolicy).execute(request(name, args), {
    signal: new AbortController().signal,
    onUpdate() {},
  });
}

function output(result: ToolExecutionResult): string {
  if (result.status !== 'success') {
    throw new Error(`Expected success, received ${result.status}`);
  }

  return result.content.map((block) => block.text).join('\n');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-managed-read-'));

  root = join(sandbox, 'workspace');

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/example'), {
    recursive: true,
  });
  await mkdir(join(root, '.git'));

  await writeFile(
    join(root, 'src/main.ts'),
    [
      'export const answer = 42;',
      'export const name = "russet";',
      'export function main() {}',
    ].join('\n'),
  );

  await writeFile(join(root, '.env'), 'PRIVATE_VALUE=do-not-expose');

  await writeFile(join(root, '.git/config'), 'private git config');

  await writeFile(
    join(root, 'node_modules/example/index.js'),
    'generated dependency code',
  );

  workspace = await createWorkspace(root);
  policy = createWorkspacePolicy({ mode: 'read_only' });
});

afterEach(async () => {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
});

describe('managed file reading', () => {
  it('reads a permitted file with numbered lines', async () => {
    const result = await execute('fs_read', {
      path: 'src/main.ts',
      startLine: 2,
      maxLines: 1,
    });

    const text = output(result);

    expect(text).toContain('2 | export const name = "russet";');

    expect(text).not.toContain('export const answer');
    expect(text).toContain('Additional lines available');
  });

  it('rejects protected files and traversal', async () => {
    for (const path of ['.env', '.git/config', '../outside.txt']) {
      const result = await execute('fs_read', { path });

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'permission_denied',
      });
    }
  });

  it('rejects symlinks to outside resources', async () => {
    const outside = join(sandbox, 'outside.txt');

    await writeFile(outside, 'outside content');
    await symlink(outside, join(root, 'src/linked.ts'));

    const result = await execute('fs_read', {
      path: 'src/linked.ts',
    });

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });
  });

  it('rejects oversized files without uncertain effects', async () => {
    await writeFile(join(root, 'src/large.txt'), 'x'.repeat(256 * 1024 + 1));

    const result = await execute('fs_read', {
      path: 'src/large.txt',
    });

    expect(result).toMatchObject({
      status: 'failed',
      sideEffects: 'none',
    });

    if (result.status === 'failed') {
      expect(result.message).toContain('256 KiB');
    }
  });

  it('rejects invalid UTF-8 and binary files', async () => {
    await writeFile(join(root, 'src/binary.dat'), Buffer.from([65, 0, 66]));

    await writeFile(join(root, 'src/invalid.txt'), Buffer.from([0xff, 0xfe]));

    for (const path of ['src/binary.dat', 'src/invalid.txt']) {
      const result = await execute('fs_read', { path });

      expect(result).toMatchObject({
        status: 'failed',
        sideEffects: 'none',
      });
    }
  });
});

describe('managed directory discovery', () => {
  it('lists permitted files without leaking protected paths', async () => {
    const text = output(
      await execute('fs_list', {
        path: '.',
        recursive: true,
      }),
    );

    expect(text).toContain('src/main.ts');

    expect(text).not.toContain('.env');
    expect(text).not.toContain('.git/config');
    expect(text).not.toContain('node_modules/example/index.js');
  });

  it('allows an explicitly requested generated file', async () => {
    const text = output(
      await execute('fs_read', {
        path: 'node_modules/example/index.js',
      }),
    );

    expect(text).toContain('generated dependency code');
  });

  it('reports limited directory results explicitly', async () => {
    for (let index = 0; index < 140; index++) {
      await writeFile(
        join(root, 'src', `file-${index}.ts`),
        `export const value = ${index};`,
      );
    }

    const text = output(
      await execute('fs_list', {
        path: 'src',
      }),
    );

    expect(text).toContain('Discovery incomplete or output limited');
  });
});

describe('managed search', () => {
  it('searches filenames and text', async () => {
    const paths = output(
      await execute('fs_search', {
        path: '.',
        mode: 'path',
        query: 'MAIN.TS',
      }),
    );

    expect(paths).toContain('src/main.ts');

    const content = output(
      await execute('fs_search', {
        path: '.',
        mode: 'content',
        query: 'ANSWER',
      }),
    );

    expect(content).toContain('export const answer = 42');

    expect(content).toContain('src/main.ts');
  });

  it('does not expose protected file contents', async () => {
    const content = output(
      await execute('fs_search', {
        path: '.',
        mode: 'content',
        query: 'PRIVATE_VALUE',
      }),
    );

    expect(content).toContain('Matches shown: 0');
    expect(content).not.toContain('do-not-expose');
  });

  it('does not infer read permission from search permission', async () => {
    const restricted = createWorkspacePolicy({
      mode: 'read_only',
      workspaceRestrictions: {
        'fs.read': 'deny',
      },
    });

    const content = output(
      await execute(
        'fs_search',
        {
          path: '.',
          mode: 'content',
          query: 'answer',
        },
        restricted,
      ),
    );

    expect(content).toContain('Matches shown: 0');
    expect(content).toContain('Files skipped');
  });
});

describe('context integration', () => {
  it('activates nested instructions after a successful read', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Root guidance');

    await writeFile(join(root, 'src/AGENTS.md'), '# Source-specific guidance');

    const context = createWorkspaceContext({
      workspace,
      policy,
    });

    const onRelevantTarget = createContextRelevanceTracker(context);

    const runtime = createRuntimeGateway({
      workspace,
      policy,
      registry: createToolRegistry(
        createManagedReadTools({
          workspace,
          policy,
          onRelevantTarget,
        }),
      ),
    });

    const before = await context.prepare({
      runId: 'test',
      modelRequestOrdinal: 1,
      model: { providerId: 'test', modelId: 'test' },
      conversation: [],
      signal: new AbortController().signal,
    });

    expect(before.instructions).toContain('# Root guidance');

    expect(before.instructions).not.toContain('Source-specific guidance');

    const result = await runtime.execute(
      request('fs_read', {
        path: 'src/main.ts',
      }),
      {
        signal: new AbortController().signal,
        onUpdate() {},
      },
    );

    expect(result.status).toBe('success');

    const after = await context.prepare({
      runId: 'test',
      modelRequestOrdinal: 2,
      model: { providerId: 'test', modelId: 'test' },
      conversation: [],
      signal: new AbortController().signal,
    });

    expect(after.instructions).toContain('# Source-specific guidance');

    expect(after.revision).not.toBe(before.revision);
  });
});
