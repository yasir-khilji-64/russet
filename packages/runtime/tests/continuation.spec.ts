import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentOptions } from '@russet/agent';

import { createMutationContextGuard } from '../src/context/mutation.js';
import { createWorkspaceContext } from '../src/context/provider.js';
import {
  createRuntimeGateway,
  createToolRegistry,
  createWorkspace,
  createWorkspacePolicy,
} from '../src/index.js';
import { createManagedWriteTools } from '../src/tools/builtins/write.js';

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;
type ModelResponse = Awaited<ReturnType<InferenceStream['result']>>;
type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

function toolResponse(
  calls: readonly {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }[],
): ModelResponse {
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

function stopResponse(): ModelResponse {
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
        text: 'The operations have finished.',
      },
    ],
  };
}

function scriptedInference(responses: readonly ModelResponse[]) {
  const requests: ModelRequest[] = [];
  let index = 0;

  const inference: AgentOptions['inference'] = {
    stream(request) {
      requests.push(request);

      const response = responses[index++];

      if (!response) {
        throw new Error('Unexpected additional inference request.');
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

describe('Agent–Runtime integration: continuation', () => {
  let sandbox: string;
  let root: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), {
      recursive: true,
    });

    await writeFile(
      join(root, 'AGENTS.md'),
      [
        '# Workspace instructions',
        '',
        'Use only authorized workspace operations.',
        'Do not modify files outside the workspace.',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  async function createHarness(responses: readonly ModelResponse[]) {
    const workspace = await createWorkspace(root);

    const policy = createWorkspacePolicy({
      mode: 'workspace_write',
    });

    const context = createWorkspaceContext({
      workspace,
      policy,
    });

    const mutationContext = createMutationContextGuard({
      workspace,
      policy,
      context,
      onRelevantTarget(target) {
        context.setRelevantTargets([{ kind: 'directory', path: '.' }, target]);
      },
    });

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      mutationContext,
      registry: createToolRegistry(
        createManagedWriteTools({
          workspace,
        }),
      ),
    });

    const scripted = scriptedInference(responses);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
      contextProvider: context,
    });

    return {
      agent,
      requests: scripted.requests,
    };
  }

  it('executes a real managed tool and continues inference', async () => {
    const content = 'Created by Russet H3.\n';

    const harness = await createHarness([
      toolResponse([
        {
          id: 'call-1',
          name: 'fs_create',
          arguments: {
            path: 'src/new.txt',
            content,
          },
        },
      ]),
      stopResponse(),
    ]);

    const eventTypes: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Create src/new.txt.',
        },
        (event) => {
          eventTypes.push(event.type);
        },
      ).result;

      expect(result.status).toBe('completed');

      expect(await readFile(join(root, 'src/new.txt'), 'utf8')).toBe(content);

      expect(harness.requests).toHaveLength(2);

      expect(harness.requests[0]?.systemPrompt).toContain(
        'Workspace instructions',
      );

      expect(
        harness.requests[0]?.tools?.some((tool) => tool.name === 'fs_create'),
      ).toBe(true);

      const continuation = harness.requests[1];

      expect(continuation?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool_result',
      ]);

      const toolResult = continuation?.messages.at(-1);

      expect(toolResult?.role).toBe('tool_result');

      if (toolResult?.role !== 'tool_result') {
        throw new Error('Expected a tool result.');
      }

      expect(toolResult.toolCallId).toBe('call-1');
      expect(toolResult.toolName).toBe('fs_create');
      expect(toolResult.isError).toBe(false);

      expect(toolResult.content[0]?.text).toContain('Created:');

      expect(
        eventTypes.filter((type) => type === 'tool.dispatch.finished'),
      ).toHaveLength(1);

      expect(eventTypes.at(-1)).toBe('run.finished');

      expect(
        harness.agent.getConversation().map((message) => message.role),
      ).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('preserves ordered results after a partial tool batch', async () => {
    const harness = await createHarness([
      toolResponse([
        {
          id: 'call-1',
          name: 'fs_create',
          arguments: {
            path: 'src/first.txt',
            content: 'First file.',
          },
        },
        {
          id: 'call-2',
          name: 'fs_create',
          arguments: {
            path: '../outside.txt',
            content: 'Not permitted.',
          },
        },
        {
          id: 'call-3',
          name: 'fs_create',
          arguments: {
            path: 'src/third.txt',
            content: 'Should be skipped.',
          },
        },
      ]),
      stopResponse(),
    ]);

    const eventTypes: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Create the requested files.',
        },
        (event) => {
          eventTypes.push(event.type);
        },
      ).result;

      expect(result.status).toBe('completed');

      expect(await readFile(join(root, 'src/first.txt'), 'utf8')).toBe(
        'First file.',
      );

      await expect(
        readFile(join(root, 'src/third.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await expect(
        readFile(join(sandbox, 'outside.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const continuation = harness.requests[1];

      const results = continuation?.messages.filter(
        (message) => message.role === 'tool_result',
      );

      expect(results?.map((message) => message.toolCallId)).toEqual([
        'call-1',
        'call-2',
        'call-3',
      ]);

      expect(results?.map((message) => message.isError)).toEqual([
        false,
        true,
        true,
      ]);

      expect(results?.[1]?.content[0]?.text).toContain('permission_denied');

      expect(results?.[2]?.content[0]?.text).toContain('Not executed');

      expect(eventTypes.filter((type) => type === 'tool.skipped')).toHaveLength(
        1,
      );
    } finally {
      await harness.agent.dispose();
    }
  });
});
