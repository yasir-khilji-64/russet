import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  InferenceRequest,
  ModelResponse,
  ModelStream,
} from '@russet/ai';

import { createAgent } from '../src/index.js';
import type {
  AgentContextProvider,
  AgentEvent,
  ToolExecutionGateway,
} from '../src/index.js';

const model = {
  providerId: 'test',
  modelId: 'context-model',
};

function reply(id: string, finishReason: 'stop' | 'tool_use'): ModelResponse {
  return {
    requestId: `request-${id}`,
    messageId: `message-${id}`,
    model,
    protocol: 'openai-completions',
    finishReason,
    thinkingAvailability: 'unavailable',
    blocks:
      finishReason === 'tool_use'
        ? [
            {
              id: `block-${id}`,
              type: 'toolcall',
              toolCall: {
                toolCallId: `call-${id}`,
                name: 'echo',
                arguments: { value: 1 },
              },
            },
          ]
        : [
            {
              id: `block-${id}`,
              type: 'text',
              text: 'Done.',
            },
          ],
  };
}

function fakeInference(replies: readonly ModelResponse[]): {
  readonly inference: InferenceEngine;
  readonly requests: InferenceRequest[];
} {
  const requests: InferenceRequest[] = [];

  return {
    requests,
    inference: {
      stream(request): ModelStream {
        const response = replies[requests.length];

        if (response === undefined) {
          throw new Error('Unexpected inference request.');
        }

        requests.push(request);
        let consumed = false;

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

            consumed = true;
          },

          async result() {
            if (!consumed) {
              throw new Error('Stream was not fully consumed.');
            }

            return response;
          },
        };
      },
    },
  };
}

describe('Agent context preparation', () => {
  it('refreshes context across model requests', async () => {
    const { inference, requests } = fakeInference([
      reply('one', 'tool_use'),
      reply('two', 'stop'),
    ]);

    const seenOrdinals: number[] = [];
    const events: AgentEvent[] = [];

    const contextProvider: AgentContextProvider = {
      async prepare(request) {
        seenOrdinals.push(request.modelRequestOrdinal);

        return {
          instructions: `Workspace context ${request.modelRequestOrdinal}`,
          revision: `revision-${request.modelRequestOrdinal}`,
        };
      },
    };

    const gateway: ToolExecutionGateway = {
      async listModelTools() {
        return [
          {
            name: 'echo',
            description: 'Return a text result.',
            parameters: { type: 'object' },
          },
        ];
      },

      async execute(_request, context) {
        context.onUpdate({ type: 'execution.started' });

        return {
          status: 'success',
          content: [{ type: 'text', text: 'Partial result' }],
          truncated: true,
        };
      },
    };

    const agent = createAgent({
      inference,
      toolGateway: gateway,
      contextProvider,
    });

    const run = agent.start(
      {
        message: 'Inspect the workspace.',
        model,
        systemPrompt: 'Base instructions',
      },
      (event) => {
        events.push(event);
      },
    );

    const result = await run.result;

    expect(result.status).toBe('completed');
    expect(seenOrdinals).toEqual([1, 2]);

    expect(requests.map((request) => request.systemPrompt)).toEqual([
      'Base instructions\n\nWorkspace context 1',
      'Base instructions\n\nWorkspace context 2',
    ]);

    const toolResult = requests[1]?.messages.find(
      (message) => message.role === 'tool_result',
    );

    expect(toolResult?.role).toBe('tool_result');

    if (toolResult?.role !== 'tool_result') {
      throw new Error('Expected a tool result.');
    }

    expect(toolResult.content.at(-1)?.text).toContain('truncated');

    const contextEvents = events.filter(
      (event) => event.type === 'model.context.prepared',
    );

    expect(contextEvents.map((event) => event.revision)).toEqual([
      'revision-1',
      'revision-2',
    ]);

    await agent.dispose();
  });

  it('preserves existing behavior without a provider', async () => {
    const { inference, requests } = fakeInference([reply('one', 'stop')]);

    const agent = createAgent({ inference });

    const result = await agent.start({
      message: 'Hello.',
      model,
      systemPrompt: 'Existing instructions',
    }).result;

    expect(result.status).toBe('completed');
    expect(requests[0]?.systemPrompt).toBe('Existing instructions');

    await agent.dispose();
  });

  it('fails before inference when preparation fails', async () => {
    const { inference, requests } = fakeInference([reply('one', 'stop')]);

    const agent = createAgent({
      inference,
      contextProvider: {
        async prepare() {
          throw new Error('Context unavailable.');
        },
      },
    });

    const result = await agent.start({
      message: 'Hello.',
      model,
    }).result;

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('context_preparation_error');
    expect(requests).toHaveLength(0);

    await agent.dispose();
  });

  it('cancels a pending context preparation', async () => {
    const { inference, requests } = fakeInference([reply('one', 'stop')]);

    let entered!: () => void;

    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const agent = createAgent({
      inference,
      contextProvider: {
        prepare() {
          entered();

          return new Promise(() => {});
        },
      },
    });

    const run = agent.start({
      message: 'Hello.',
      model,
    });

    await preparing;
    run.cancel('User cancelled.');

    const result = await run.result;

    expect(result.status).toBe('cancelled');
    expect(requests).toHaveLength(0);

    await agent.dispose();
  });
});
