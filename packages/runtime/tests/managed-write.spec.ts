import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ToolExecutionGateway,
  ToolExecutionResult,
  ToolExecutionUpdate,
} from '@russet/agent';

import {
  createContextRelevanceTracker,
  createManagedWriteTools,
  createMutationContextGuard,
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspaceContext,
  createWorkspacePolicy,
} from '../src/index.js';
import type {
  ApprovalBroker,
  Workspace,
  WorkspaceContext,
  WorkspacePolicy,
} from '../src/index.js';

let sandbox: string;
let root: string;
let workspace: Workspace;
let policy: WorkspacePolicy;
let context: WorkspaceContext;

const runId = 'test-run';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function prepareRequest() {
  return {
    runId,
    modelRequestOrdinal: 1,
    model: {
      providerId: 'test',
      modelId: 'test-model',
    },
    conversation: [],
    signal: new AbortController().signal,
  };
}

function createGateway(
  broker?: ApprovalBroker,
  selectedPolicy = policy,
  timeoutMs = 1000,
): ToolExecutionGateway {
  const selectedContext =
    selectedPolicy === policy
      ? context
      : createWorkspaceContext({
          workspace,
          policy: selectedPolicy,
        });

  const onRelevantTarget = createContextRelevanceTracker(selectedContext);

  const mutationContext = createMutationContextGuard({
    workspace,
    policy: selectedPolicy,
    context: selectedContext,
    onRelevantTarget,
  });

  return createRuntimeGateway({
    workspace,
    policy: selectedPolicy,
    mutationContext,
    ...(broker === undefined ? {} : { approvalBroker: broker }),
    approvalTimeoutMs: timeoutMs,
    registry: createToolRegistry(
      createManagedWriteTools({
        workspace,
        onRelevantTarget,
      }),
    ),
  });
}

async function execute(
  gateway: ToolExecutionGateway,
  name: string,
  args: unknown,
  options?: {
    signal?: AbortSignal;
    onUpdate?: (update: ToolExecutionUpdate) => void;
  },
): Promise<ToolExecutionResult> {
  return gateway.execute(
    {
      runId,
      modelRequestId: 'model-request-1',
      toolExecutionId: 'execution-1',
      toolCall: {
        toolCallId: 'call-1',
        name,
        arguments: args,
      },
    },
    {
      signal: options?.signal ?? new AbortController().signal,
      onUpdate: options?.onUpdate ?? (() => undefined),
    },
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-write-'));

  root = join(sandbox, 'workspace');

  await mkdir(join(root, 'src'), {
    recursive: true,
  });

  await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');

  workspace = await createWorkspace(root);

  policy = createWorkspacePolicy({
    mode: 'workspace_write',
  });

  context = createWorkspaceContext({
    workspace,
    policy,
  });

  await context.prepare(prepareRequest());
});

afterEach(async () => {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
});

describe('managed file creation', () => {
  it('creates an absent file', async () => {
    const gateway = createGateway();

    const result = await execute(gateway, 'fs_create', {
      path: 'src/new.ts',
      content: 'export const created = true;\n',
    });

    expect(result.status).toBe('success');

    expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe(
      'export const created = true;\n',
    );
  });

  it('never overwrites an existing file', async () => {
    const gateway = createGateway();

    const result = await execute(gateway, 'fs_create', {
      path: 'src/main.ts',
      content: 'overwritten',
    });

    expect(result.status).toBe('rejected');

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
  });

  it('rejects protected targets', async () => {
    const gateway = createGateway();

    const result = await execute(gateway, 'fs_create', {
      path: '.env',
      content: 'SECRET=value',
    });

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });
  });
});

describe('managed replacement and editing', () => {
  it('replaces a file with its expected hash', async () => {
    const original = 'export const value = 1;\n';
    const updated = 'export const value = 2;\n';

    const result = await execute(createGateway(), 'fs_write', {
      path: 'src/main.ts',
      content: updated,
      expectedSha256: sha(original),
    });

    expect(result.status).toBe('success');

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(updated);
  });

  it('rejects stale replacement without mutation', async () => {
    const result = await execute(createGateway(), 'fs_write', {
      path: 'src/main.ts',
      content: 'replacement',
      expectedSha256: sha('old version'),
    });

    expect(result).toMatchObject({
      status: 'failed',
      sideEffects: 'none',
    });

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
  });

  it('edits one exact occurrence', async () => {
    const original = 'export const value = 1;\n';

    const result = await execute(createGateway(), 'fs_edit', {
      path: 'src/main.ts',
      expectedSha256: sha(original),
      oldText: 'value = 1',
      newText: 'value = 42',
    });

    expect(result.status).toBe('success');

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 42;\n',
    );
  });

  it('rejects ambiguous edits', async () => {
    const content = 'value value';

    await writeFile(join(root, 'src/main.ts'), content);

    const result = await execute(createGateway(), 'fs_edit', {
      path: 'src/main.ts',
      expectedSha256: sha(content),
      oldText: 'value',
      newText: 'other',
    });

    expect(result).toMatchObject({
      status: 'failed',
      sideEffects: 'none',
    });

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(content);
  });

  it('requires read authority for replacement', async () => {
    const restricted = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.read': 'deny',
      },
    });

    const result = await execute(
      createGateway(undefined, restricted),
      'fs_write',
      {
        path: 'src/main.ts',
        content: 'updated',
        expectedSha256: sha('export const value = 1;\n'),
      },
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });
  });
});

describe('operation-bound approvals', () => {
  it('fails closed when approval is unavailable', async () => {
    const restricted = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.write': 'ask',
      },
    });

    const preparedContext = createWorkspaceContext({
      workspace,
      policy: restricted,
    });

    await preparedContext.prepare(prepareRequest());

    const tracker = createContextRelevanceTracker(preparedContext);

    const gateway = createRuntimeGateway({
      workspace,
      policy: restricted,
      mutationContext: createMutationContextGuard({
        workspace,
        policy: restricted,
        context: preparedContext,
        onRelevantTarget: tracker,
      }),
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
          onRelevantTarget: tracker,
        }),
      ),
    });

    const result = await execute(gateway, 'fs_create', {
      path: 'src/new.ts',
      content: 'new',
    });

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'approval_unavailable',
    });
  });

  it('requires approval for AGENTS.md changes', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Workspace instructions\n');

    await context.prepare(prepareRequest());

    const updates: ToolExecutionUpdate[] = [];

    const result = await execute(
      createGateway(),
      'fs_write',
      {
        path: 'AGENTS.md',
        content: '# Modified instructions\n',
        expectedSha256: sha('# Workspace instructions\n'),
      },
      {
        onUpdate: (update) => updates.push(update),
      },
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'approval_unavailable',
    });

    expect(updates).not.toContainEqual({
      type: 'execution.started',
    });
  });

  it('allows a scoped approved operation', async () => {
    const restricted = createWorkspacePolicy({
      mode: 'workspace_write',
      workspaceRestrictions: {
        'fs.write': 'ask',
      },
    });

    const approvedContext = createWorkspaceContext({
      workspace,
      policy: restricted,
    });

    await approvedContext.prepare(prepareRequest());

    const tracker = createContextRelevanceTracker(approvedContext);

    const broker: ApprovalBroker = {
      async request(approval) {
        expect(approval.fingerprint).toMatch(/^[a-f0-9]{64}$/);

        expect(approval.description).toContain('src/new.ts');

        return 'allow';
      },
    };

    const gateway = createRuntimeGateway({
      workspace,
      policy: restricted,
      approvalBroker: broker,
      mutationContext: createMutationContextGuard({
        workspace,
        policy: restricted,
        context: approvedContext,
        onRelevantTarget: tracker,
      }),
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
          onRelevantTarget: tracker,
        }),
      ),
    });

    const updates: ToolExecutionUpdate[] = [];

    const result = await execute(
      gateway,
      'fs_create',
      {
        path: 'src/new.ts',
        content: 'approved',
      },
      {
        onUpdate: (update) => updates.push(update),
      },
    );

    expect(result.status).toBe('success');

    expect(updates.map((update) => update.type)).toEqual([
      'approval.requested',
      'approval.resolved',
      'execution.started',
    ]);
  });
});

describe('context-sensitive mutation preflight', () => {
  it('defers changes when nested instructions are missing', async () => {
    await writeFile(join(root, 'src/AGENTS.md'), '# Source package guidance');

    const onRelevantTarget = createContextRelevanceTracker(context);

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      mutationContext: createMutationContextGuard({
        workspace,
        policy,
        context,
        onRelevantTarget,
      }),
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
          onRelevantTarget,
        }),
      ),
    });

    const args = {
      path: 'src/main.ts',
      content: 'updated',
      expectedSha256: sha('export const value = 1;\n'),
    };

    const first = await execute(gateway, 'fs_write', args);

    expect(first).toMatchObject({
      status: 'rejected',
      code: 'context_refresh_required',
    });

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );

    await context.prepare({
      ...prepareRequest(),
      modelRequestOrdinal: 2,
    });

    const second = await execute(gateway, 'fs_write', args);

    expect(second.status).toBe('success');

    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe('updated');
  });
});
