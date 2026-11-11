import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

type InferenceStream = ReturnType<AgentOptions['inference']['stream']>;

type FakeResponse = Awaited<ReturnType<InferenceStream['result']>>;

type ModelRequest = Parameters<AgentOptions['inference']['stream']>[0];

const model = {
  providerId: 'test',
  modelId: 'scripted',
};

const proposal = {
  toolCallId: 'call-1',
  name: 'mock_read',
  arguments: {
    path: 'src/main.ts',
  },
};

function stopResponse(ordinal: number): FakeResponse {
  return {
    requestId: `request-${ordinal}`,
    messageId: `message-${ordinal}`,
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: `text-${ordinal}`,
        type: 'text',
        text: 'The request has completed.',
      },
    ],
  };
}

function toolResponse(): FakeResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: 'block-1',
        type: 'toolcall',
        toolCall: proposal,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });

  return { promise, resolve };
}

interface ScriptedStep {
  readonly response: FakeResponse;
  readonly preview?: typeof proposal;
  readonly waitFor?: Promise<void>;
}

function scriptedInference(steps: readonly ScriptedStep[]) {
  const requests: ModelRequest[] = [];
  let index = 0;

  const inference: AgentOptions['inference'] = {
    stream(request) {
      requests.push(request);

      const step = steps[index++];

      if (!step) {
        throw new Error('Unexpected model request.');
      }

      const { response, preview, waitFor } = step;

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'response.started' as const,
            requestId: response.requestId,
            messageId: response.messageId,
          };

          if (preview !== undefined) {
            yield {
              type: 'toolcall.completed' as const,
              requestId: response.requestId,
              messageId: response.messageId,
              blockId: 'preview-block',
              toolCall: preview,
            };
          }

          if (waitFor !== undefined) {
            await waitFor;
          }

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

describe('Agent–Runtime integration: execution integrity', () => {
  let sandbox: string;
  let root: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'russet-h3-integrity-'));

    root = join(sandbox, 'workspace');

    await mkdir(join(root, 'src'), {
      recursive: true,
    });

    await writeFile(join(root, 'src/main.ts'), 'export const value = 1;\n');
  });

  afterEach(async () => {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });
  });

  async function createHarness(steps: readonly ScriptedStep[]) {
    const workspace = await createWorkspace(root);

    const policy = createWorkspacePolicy({
      mode: 'read_only',
    });

    const executed = vi.fn(() => 'File inspected.');

    const tool = defineRuntimeTool<{ path: string }>({
      name: 'mock_read',
      description: 'Read an existing workspace file.',
      action: 'fs.read',
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
        },
        {
          additionalProperties: false,
        },
      ),

      target(args) {
        return {
          path: args.path,
          expectation: 'existing',
        };
      },

      execute(_args, context) {
        expect(context.resource.kind).toBe('file');

        return executed();
      },
    });

    const gateway = createRuntimeGateway({
      workspace,
      policy,
      registry: createToolRegistry([tool]),
    });

    const scripted = scriptedInference(steps);

    const agent = createAgent({
      inference: scripted.inference,
      toolGateway: gateway,
    });

    return {
      agent,
      executed,
      requests: scripted.requests,
    };
  }

  it('never executes a streamed proposal when the final response stops', async () => {
    const harness = await createHarness([
      {
        response: stopResponse(1),
        preview: proposal,
      },
    ]);

    const events: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Inspect src/main.ts.',
        },
        (event) => {
          events.push(event.type);
        },
      ).result;

      expect(result.status).toBe('completed');

      expect(harness.executed).not.toHaveBeenCalled();

      expect(harness.requests).toHaveLength(1);

      expect(events).toContain('model.event');
      expect(events).not.toContain('tool.proposed');
      expect(events).not.toContain('tool.dispatch.started');

      expect(
        harness.agent.getConversation().map((message) => message.role),
      ).toEqual(['user', 'assistant']);
    } finally {
      await harness.agent.dispose();
    }
  });

  it('dispatches only after the authoritative response completes', async () => {
    const releaseCompletion = deferred<void>();
    const previewObserved = deferred<void>();

    const harness = await createHarness([
      {
        response: toolResponse(),
        preview: proposal,
        waitFor: releaseCompletion.promise,
      },
      {
        response: stopResponse(2),
      },
    ]);

    const events: string[] = [];

    try {
      const run = harness.agent.start(
        {
          model,
          message: 'Inspect src/main.ts.',
        },
        (event) => {
          events.push(event.type);

          if (
            event.type === 'model.event' &&
            event.event.type === 'toolcall.completed'
          ) {
            previewObserved.resolve();
          }
        },
      );

      // The model has streamed a complete-looking tool proposal,
      // but its authoritative response has not completed.
      await previewObserved.promise;

      expect(harness.executed).not.toHaveBeenCalled();

      expect(events).not.toContain('tool.proposed');
      expect(events).not.toContain('tool.dispatch.started');

      // Only now may the model response complete.
      releaseCompletion.resolve();

      const result = await run.result;

      expect(result.status).toBe('completed');

      expect(harness.executed).toHaveBeenCalledOnce();

      expect(harness.requests).toHaveLength(2);

      const modelFinishedIndex = events.indexOf('model.request.finished');

      const toolProposedIndex = events.indexOf('tool.proposed');

      const dispatchIndex = events.indexOf('tool.dispatch.started');

      expect(modelFinishedIndex).toBeGreaterThanOrEqual(0);
      expect(toolProposedIndex).toBeGreaterThan(modelFinishedIndex);
      expect(dispatchIndex).toBeGreaterThan(toolProposedIndex);

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
      expect(toolResult.toolName).toBe('mock_read');
      expect(toolResult.isError).toBe(false);
    } finally {
      releaseCompletion.resolve();
      await harness.agent.dispose();
    }
  });

  it('rejects malformed authoritative tool calls before dispatch', async () => {
    const invalid: FakeResponse = {
      ...toolResponse(),
      blocks: [
        {
          id: 'invalid-block',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'mock_read',
            // Arrays are not valid tool argument objects.
            arguments: ['src/main.ts'],
          },
        },
      ],
    };

    const harness = await createHarness([
      {
        response: invalid,
      },
    ]);

    const events: string[] = [];

    try {
      const result = await harness.agent.start(
        {
          model,
          message: 'Inspect src/main.ts.',
        },
        (event) => {
          events.push(event.type);
        },
      ).result;

      expect(result.status).toBe('failed');

      expect(result.failure?.kind).toBe('invalid_model_response');

      expect(harness.executed).not.toHaveBeenCalled();

      expect(harness.requests).toHaveLength(1);

      expect(events).not.toContain('tool.dispatch.started');

      // The invalid response must not be committed as a
      // successful assistant/tool conversation cycle.
      expect(harness.agent.getConversation()).toHaveLength(0);
    } finally {
      await harness.agent.dispose();
    }
  });
});
