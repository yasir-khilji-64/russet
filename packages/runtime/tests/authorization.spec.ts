import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Type from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

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
import { createManagedWriteTools } from '../src/tools/builtins/write.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

interface ProposedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function toolResponse(calls: readonly ProposedCall[]): FakeResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: calls.map((call) => ({
      id: `block-${call.id}`,
      type: 'toolcall' as const,
      toolCall: {
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    })),
  };
}

function stopResponse(): FakeResponse {
  return {
    requestId: 'request-2',
    messageId: 'message-2',
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: 'final-text',
        type: 'text',
        text: 'The operation outcomes have been recorded.',
      },
    ],
  };
}

function scriptedInference(responses: readonly FakeResponse[]) {
  const requests: ModelRequest[] = [];
  let index = 0;

  const inference: AgentOptions['inference'] = {
    stream(request) {
      requests.push(request);

      const response = responses[index++];

      if (!response) {
        throw new Error('Unexpected inference request.');
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
  };

  return { inference, requests };
}

const readSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

function createObservedReadTool(execute: () => void): RegisteredRuntimeTool {
  return defineRuntimeTool<{ path: string }>({
    name: 'observed_read',
    description: 'Inspect a workspace file for an integration test.',
    action: 'fs.read',
    parameters: readSchema,

    target(args) {
      return {
        path: args.path,
        expectation: 'existing',
      };
    },

    execute() {
      execute();
      return 'Observed read completed.';
    },
  });
}

describe('Agent–Runtime integration: authorization', () => {
  let sandbox: string;
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-auth-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), {
      recursive: true,
    });

    await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');

    await writeFile(join(root, '.env'), 'SECRET=protected\n');

    workspace = await createWorkspace(root);
  });

  afterEach(async () => {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  function createHarness(
    policy: WorkspacePolicy,
    tools: readonly RegisteredRuntimeTool[],
    calls: readonly ProposedCall[],
  ) {
    const gateway = createRuntimeGateway({
      workspace,
      policy,
      registry: createToolRegistry(tools),
    });

    const scripted = scriptedInference([toolResponse(calls), stopResponse()]);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
    });

    return {
      agent,
      requests: scripted.requests,
    };
  }

  it('denies a tool proposal excluded by the effective policy', async () => {
    const execute = vi.fn();

    const policy = createWorkspacePolicy({
      mode: 'read_only',
      workspaceRestrictions: {
        'fs.read': 'deny',
      },
    });

    const harness = createHarness(
      policy,
      [createObservedReadTool(execute)],
      [
        {
          id: 'call-1',
          name: 'observed_read',
          arguments: { path: 'src/main.ts' },
        },
      ],
    );

    try {
      const result = await harness.agent.start({
        model,
        message: 'Inspect src/main.ts.',
      }).result;

      expect(result.status).toBe('completed');
      expect(execute).not.toHaveBeenCalled();

      // Runtime must not advertise a denied tool.
      expect(harness.requests[0]?.tools ?? []).toHaveLength(0);

      // A scripted model can still propose it; execution must deny.
      const continuation = harness.requests[1];

      const toolResult = continuation?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult).toMatchObject({
        role: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'observed_read',
        isError: true,
      });

      expect(toolResult?.content[0]?.text).toContain('permission_denied');
    } finally {
      await harness.agent.dispose();
    }
  });

  it('rejects malformed arguments and skips later proposals', async () => {
    const execute = vi.fn();

    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    const harness = createHarness(
      policy,
      [createObservedReadTool(execute)],
      [
        {
          id: 'call-1',
          name: 'observed_read',
          arguments: {
            path: 'src/main.ts',
            extra: true,
          },
        },
        {
          id: 'call-2',
          name: 'observed_read',
          arguments: {
            path: 'src/main.ts',
          },
        },
      ],
    );

    const skipped: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Inspect the source file.',
        },
        (event) => {
          if (event.type === 'tool.skipped') {
            skipped.push(event.toolCallId);
          }
        },
      ).result;

      expect(result.status).toBe('completed');
      expect(execute).not.toHaveBeenCalled();

      const results = harness.requests[1]?.messages.filter(
        (message) => message.role === 'tool_result',
      );

      expect(results?.map((message) => message.toolCallId)).toEqual([
        'call-1',
        'call-2',
      ]);

      expect(results?.map((message) => message.isError)).toEqual([true, true]);

      expect(results?.[0]?.content[0]?.text).toContain('invalid_arguments');

      expect(results?.[1]?.content[0]?.text).toContain('Not executed');

      expect(skipped).toEqual(['call-2']);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('rejects unknown tool proposals without executing handlers', async () => {
    const execute = vi.fn();

    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    const harness = createHarness(
      policy,
      [createObservedReadTool(execute)],
      [
        {
          id: 'unknown-call',
          name: 'unregistered_tool',
          arguments: {},
        },
      ],
    );

    try {
      const result = await harness.agent.start({
        model,
        message: 'Call an unregistered tool.',
      }).result;

      expect(result.status).toBe('completed');
      expect(execute).not.toHaveBeenCalled();

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('unknown_tool');
    } finally {
      await harness.agent.dispose();
    }
  });

  it.each([
    ['parent traversal', '../outside.ts'],
    ['protected resource', '.env'],
  ])('rejects %s access', async (_reason, path) => {
    const execute = vi.fn();

    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    const harness = createHarness(
      policy,
      [createObservedReadTool(execute)],
      [
        {
          id: 'call-1',
          name: 'observed_read',
          arguments: { path },
        },
      ],
    );

    try {
      const result = await harness.agent.start({
        model,
        message: `Inspect ${path}.`,
      }).result;

      expect(result.status).toBe('completed');
      expect(execute).not.toHaveBeenCalled();

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('permission_denied');
    } finally {
      await harness.agent.dispose();
    }
  });

  it('prevents workspace permissions from elevating a user denial', async () => {
    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
      userCeiling: {
        'fs.write': 'deny',
      },
      workspaceRestrictions: {
        'fs.write': 'allow',
      },
    });

    const harness = createHarness(
      policy,
      createManagedWriteTools({ workspace }),
      [
        {
          id: 'call-1',
          name: 'fs_create',
          arguments: {
            path: 'src/forbidden.txt',
            content: 'Should never be created.',
          },
        },
      ],
    );

    try {
      const result = await harness.agent.start({
        model,
        message: 'Create src/forbidden.txt.',
      }).result;

      expect(result.status).toBe('completed');

      await expect(
        readFile(join(root, 'src/forbidden.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(
        harness.requests[0]?.tools?.some((tool) => tool.name === 'fs_create'),
      ).toBe(false);

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('permission_denied');

      expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe(
        'export const value = 1;\n',
      );
    } finally {
      await harness.agent.dispose();
    }
  });

  it('fails closed when an approval-required read has no broker', async () => {
    const execute = vi.fn();

    const policy = createWorkspacePolicy({
      mode: 'read_only',
      workspaceRestrictions: {
        'fs.read': 'ask',
      },
    });

    const harness = createHarness(
      policy,
      [createObservedReadTool(execute)],
      [
        {
          id: 'call-1',
          name: 'observed_read',
          arguments: {
            path: 'src/main.ts',
          },
        },
      ],
    );

    try {
      const result = await harness.agent.start({
        model,
        message: 'Read src/main.ts.',
      }).result;

      expect(result.status).toBe('completed');
      expect(execute).not.toHaveBeenCalled();

      const toolResult = harness.requests[1]?.messages.find(
        (message) => message.role === 'tool_result',
      );

      expect(toolResult?.isError).toBe(true);

      expect(toolResult?.content[0]?.text).toContain('approval_unavailable');
    } finally {
      await harness.agent.dispose();
    }
  });
});
