import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgent,
  type AgentOptions,
  type ToolExecutionGateway,
  type ToolExecutionRequest,
  type ToolExecutionUpdate,
} from '@russet/agent';

import type { MutationContextGuard } from '../src/context/mutation.js';
import {
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspacePolicy,
  defineRuntimeTool,
} from '../src/index.js';
import type {
  RegisteredRuntimeTool,
  Workspace,
  WorkspacePolicy,
} from '../src/index.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;

let sandbox: string;
let root: string;
let workspace: Workspace;
let policy: WorkspacePolicy;
let executions: number;

const schema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
  },
  {
    additionalProperties: false,
  },
);

function readTool(
  output: string | (() => string) = 'Mock read result.',
): RegisteredRuntimeTool {
  return defineRuntimeTool<{ path: string }>({
    name: 'mock_read',
    description: 'Read a workspace file using a mock handler.',
    action: 'fs.read',
    parameters: schema,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    execute(_args, context) {
      executions++;

      expect(context.resource.kind).toBe('file');

      return typeof output === 'function' ? output() : output;
    },
  });
}

function writeTool(): RegisteredRuntimeTool {
  return defineRuntimeTool<{ path: string }>({
    name: 'mock_write',
    description: 'Simulate file creation.',
    action: 'fs.write',
    parameters: schema,

    target(args) {
      return {
        path: args.path,
        expectation: 'new_file',
      };
    },

    execute() {
      executions++;
      return 'Mock creation completed.';
    },
  });
}

/**
 * Gateway unit-test fixture.
 *
 * This guard simulates successfully prepared mutation context.
 * Tests using it verify gateway behavior, not real AGENTS.md
 * loading or instruction-context freshness.
 */
function readyMutationContext(onCheck?: () => void): MutationContextGuard {
  return {
    async check() {
      onCheck?.();
      return 'ready';
    },
  };
}

/**
 * An optional guard is deliberately omitted rather than
 * supplied as undefined, respecting exactOptionalPropertyTypes.
 */
function gateway(
  tools: readonly RegisteredRuntimeTool[] = [readTool()],
  selectedPolicy: WorkspacePolicy = policy,
  mutationContext?: MutationContextGuard,
): ToolExecutionGateway {
  return createRuntimeGateway({
    workspace,
    policy: selectedPolicy,
    registry: createToolRegistry(tools),
    ...(mutationContext === undefined ? {} : { mutationContext }),
  });
}

function request(
  name: string,
  arguments_: unknown = { path: 'src/main.ts' },
): ToolExecutionRequest {
  return {
    runId: 'run-1',
    modelRequestId: 'model-1',
    toolExecutionId: 'execution-1',
    toolCall: {
      toolCallId: 'call-1',
      name,
      arguments: arguments_,
    },
  };
}

function executionContext(
  controller = new AbortController(),
  updates: ToolExecutionUpdate[] = [],
) {
  return {
    signal: controller.signal,
    onUpdate(update: ToolExecutionUpdate) {
      updates.push(update);
    },
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'russet-tools-'));
  root = join(sandbox, 'workspace');

  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/main.ts'), 'export {};');
  await writeFile(join(root, '.env'), 'SECRET=test');

  workspace = await createWorkspace(root);
  policy = createWorkspacePolicy({ mode: 'read_only' });
  executions = 0;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('runtime tool registry', () => {
  it('rejects duplicate names', () => {
    expect(() => createToolRegistry([readTool(), readTool()])).toThrow(
      /Duplicate runtime tool/,
    );
  });

  it('rejects non-strict parameter schemas', () => {
    expect(() =>
      defineRuntimeTool<{ path: string }>({
        name: 'unsafe_read',
        description: 'Non-strict schema.',
        action: 'fs.read',
        parameters: Type.Object({
          path: Type.String(),
        }),
        target: (args) => ({
          path: args.path,
          expectation: 'existing',
        }),
        execute: () => 'ok',
      }),
    ).toThrow(/strict object schema/);
  });

  it('returns defensive model definitions', async () => {
    const runtime = gateway();
    const signal = new AbortController().signal;

    const first = await runtime.listModelTools({ signal });

    expect(first).toHaveLength(1);
    expect(first[0]?.name).toBe('mock_read');
    expect(first[0]?.parameters.type).toBe('object');

    first[0]!.name = 'modified';

    const second = await runtime.listModelTools({ signal });

    expect(second[0]?.name).toBe('mock_read');
  });

  it('hides tools unavailable under the current mode', async () => {
    const runtime = gateway([readTool(), writeTool()]);

    const definitions = await runtime.listModelTools({
      signal: new AbortController().signal,
    });

    expect(definitions.map((tool) => tool.name)).toEqual(['mock_read']);
  });

  it('requires prepared context for registered write actions', () => {
    const tool = defineRuntimeTool({
      name: 'example_create',
      description: 'Create a workspace file.',
      action: 'fs.write',
      requiresPreparedContext: false,
      parameters: Type.Object({}, { additionalProperties: false }),

      target() {
        return {
          path: 'example.txt',
          expectation: 'new_file',
        };
      },

      execute() {
        return 'Created';
      },
    });

    expect(tool.requiresPreparedContext).toBe(true);
    expect(tool.failureSideEffects).toBe('possible');
  });

  it('advertises a writable tool when context verification is configured', async () => {
    const writable = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const runtime = gateway(
      [readTool(), writeTool()],
      writable,
      readyMutationContext(),
    );

    const definitions = await runtime.listModelTools({
      signal: new AbortController().signal,
    });

    expect(definitions.map((tool) => tool.name)).toEqual([
      'mock_read',
      'mock_write',
    ]);
  });

  it('does not advertise a writable tool without mutation context', async () => {
    const writable = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const runtime = gateway([writeTool()], writable);

    const definitions = await runtime.listModelTools({
      signal: new AbortController().signal,
    });

    expect(definitions).toHaveLength(0);
  });
});

describe('runtime execution gateway', () => {
  it('validates, authorizes and executes a tool', async () => {
    const updates: ToolExecutionUpdate[] = [];

    const result = await gateway().execute(
      request('mock_read'),
      executionContext(undefined, updates),
    );

    expect(result).toEqual({
      status: 'success',
      content: [
        {
          type: 'text',
          text: 'Mock read result.',
        },
      ],
    });

    expect(updates).toEqual([{ type: 'execution.started' }]);
    expect(executions).toBe(1);
  });

  it('rejects unknown tools and invalid arguments', async () => {
    const runtime = gateway();

    const unknown = await runtime.execute(
      request('missing_tool'),
      executionContext(),
    );

    expect(unknown).toMatchObject({
      status: 'rejected',
      code: 'unknown_tool',
    });

    for (const args of [
      {},
      { path: 42 },
      { path: 'src/main.ts', extra: true },
      { path: 'src/main.ts', constructor: 'bad' },
    ]) {
      const result = await runtime.execute(
        request('mock_read', args),
        executionContext(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'invalid_arguments',
      });
    }

    expect(executions).toBe(0);
  });

  it('accepts strict object schemas', () => {
    const tool = readTool();

    expect(tool.validate({ path: 'src/main.ts' })).toEqual({
      path: 'src/main.ts',
    });

    expect(
      tool.validate({
        path: 'src/main.ts',
        extra: true,
      }),
    ).toBeUndefined();
  });

  it('rejects path traversal and protected resources', async () => {
    const runtime = gateway();

    for (const path of ['../outside', '.env']) {
      const result = await runtime.execute(
        request('mock_read', { path }),
        executionContext(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'permission_denied',
      });
    }

    expect(executions).toBe(0);
  });

  it('rejects symlinked resources', async () => {
    await symlink(join(root, 'src/main.ts'), join(root, 'src/linked.ts'));

    const result = await gateway().execute(
      request('mock_read', { path: 'src/linked.ts' }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });

    expect(executions).toBe(0);
  });

  it('does not permit writes in read-only mode', async () => {
    const result = await gateway([writeTool()]).execute(
      request('mock_write', { path: 'src/new.ts' }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });

    expect(executions).toBe(0);
  });

  it('allows a policy-authorized fake write with prepared context', async () => {
    const writable = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    let contextChecks = 0;

    const mutationContext = readyMutationContext(() => {
      contextChecks++;
    });

    const updates: ToolExecutionUpdate[] = [];

    const result = await gateway(
      [writeTool()],
      writable,
      mutationContext,
    ).execute(
      request('mock_write', { path: 'src/new.ts' }),
      executionContext(undefined, updates),
    );

    expect(result).toEqual({
      status: 'success',
      content: [
        {
          type: 'text',
          text: 'Mock creation completed.',
        },
      ],
    });

    expect(contextChecks).toBe(2);
    expect(executions).toBe(1);

    expect(updates).toEqual([{ type: 'execution.started' }]);
  });

  it('rejects a policy-authorized write without mutation context', async () => {
    const writable = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const runtime = gateway([writeTool()], writable);

    const result = await runtime.execute(
      request('mock_write', { path: 'src/new.ts' }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });

    expect(executions).toBe(0);
  });

  it('rejects a write when mutation context requires refresh', async () => {
    const writable = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const mutationContext: MutationContextGuard = {
      async check() {
        return 'refresh';
      },
    };

    const result = await gateway(
      [writeTool()],
      writable,
      mutationContext,
    ).execute(
      request('mock_write', { path: 'src/new.ts' }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'context_refresh_required',
    });

    expect(executions).toBe(0);
  });

  it('does not let a denied write reach the context guard', async () => {
    let contextChecks = 0;

    const mutationContext = readyMutationContext(() => {
      contextChecks++;
    });

    const result = await gateway(
      [writeTool()],
      policy,
      mutationContext,
    ).execute(
      request('mock_write', { path: 'src/new.ts' }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'permission_denied',
    });

    expect(contextChecks).toBe(0);
    expect(executions).toBe(0);
  });

  it('fails closed when approval is unavailable', async () => {
    const approvalPolicy = createWorkspacePolicy({
      mode: 'read_only',
      workspaceRestrictions: {
        'fs.read': 'ask',
      },
    });

    const runtime = gateway([readTool()], approvalPolicy);

    expect(
      await runtime.listModelTools({
        signal: new AbortController().signal,
      }),
    ).toHaveLength(0);

    const result = await runtime.execute(
      request('mock_read'),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'approval_unavailable',
    });

    expect(executions).toBe(0);
  });

  it('does not dispatch after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await gateway().execute(
      request('mock_read'),
      executionContext(controller),
    );

    expect(result).toMatchObject({
      status: 'cancelled',
      sideEffects: 'none',
    });

    expect(executions).toBe(0);
  });

  it('reports uncertain handler failure', async () => {
    const runtime = gateway([
      readTool(() => {
        throw new Error('Handler failed.');
      }),
    ]);

    const result = await runtime.execute(
      request('mock_read'),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: 'failed',
      sideEffects: 'possible',
    });
  });

  it('bounds large outputs and reports truncation', async () => {
    const runtime = gateway([readTool('x'.repeat(80 * 1024))]);

    const result = await runtime.execute(
      request('mock_read'),
      executionContext(),
    );

    expect(result.status).toBe('success');

    if (result.status !== 'success') {
      throw new Error('Expected successful tool execution.');
    }

    expect(result.truncated).toBe(true);

    expect(
      Buffer.byteLength(result.content[0]?.text ?? '', 'utf8'),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it('does not invoke a handler when the start update cancels', async () => {
    const controller = new AbortController();

    const result = await gateway().execute(request('mock_read'), {
      signal: controller.signal,
      onUpdate(update) {
        if (update.type === 'execution.started') {
          controller.abort();
        }
      },
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      sideEffects: 'none',
    });

    expect(executions).toBe(0);
  });

  it('integrates with Agent tool dispatch and continuation', async () => {
    const model = {
      providerId: 'test',
      modelId: 'mock-model',
    };

    const replies: FakeResponse[] = [
      {
        requestId: 'model-request-1',
        messageId: 'assistant-1',
        model,
        finishReason: 'tool_use',
        thinkingAvailability: 'unavailable',
        blocks: [
          {
            id: 'block-1',
            type: 'toolcall',
            toolCall: {
              toolCallId: 'call-1',
              name: 'mock_read',
              arguments: { path: 'src/main.ts' },
            },
          },
        ],
      },
      {
        requestId: 'model-request-2',
        messageId: 'assistant-2',
        model,
        finishReason: 'stop',
        thinkingAvailability: 'unavailable',
        blocks: [
          {
            id: 'block-2',
            type: 'text',
            text: 'The file was inspected.',
          },
        ],
      },
    ];

    const agent = createAgent({
      toolGateway: gateway(),

      inference: {
        stream() {
          const response = replies.shift();

          if (!response) {
            throw new Error('Unexpected model request.');
          }

          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'response.started' as const,
                requestId: response.requestId,
                messageId: response.messageId,
              };

              yield {
                type: 'response.completed' as const,
                requestId: response.requestId,
                messageId: response.messageId,
                response,
              };
            },

            async result() {
              return response;
            },
          };
        },
      },
    });

    try {
      const result = await agent.start({
        message: 'Inspect src/main.ts.',
        model,
      }).result;

      expect(result.status).toBe('completed');
      expect(executions).toBe(1);

      expect(agent.getConversation().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool_result',
        'assistant',
      ]);
    } finally {
      await agent.dispose();
    }
  });
});
