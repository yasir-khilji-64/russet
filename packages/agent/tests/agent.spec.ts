import { describe, expect, it } from 'vitest';

import type {
  InferenceEngine,
  InferenceRequest,
  ModelEvent,
  ModelId,
  ModelResponse,
  ModelStream,
  ModelToolCall,
  ToolResultConversationMessage,
} from '@russet/ai';

import { createAgent } from '../src/index.js';
import type {
  AgentEvent,
  AgentRun,
  ToolExecutionGateway,
} from '../src/index.js';

const model: ModelId = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

function finalResponse(requestId: string): ModelResponse {
  return {
    requestId,
    messageId: `message-${requestId}`,
    model,
    finishReason: 'stop',
    thinkingAvailability: 'unavailable',
    blocks: [
      {
        id: `text-${requestId}`,
        type: 'text',
        text: 'Done.',
      },
    ],
  };
}

function toolResponse(
  requestId: string,
  ids: readonly string[],
): ModelResponse {
  return {
    requestId,
    messageId: `message-${requestId}`,
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'unavailable',
    blocks: ids.map((id) => ({
      id: `block-${id}`,
      type: 'toolcall' as const,
      toolCall: {
        toolCallId: id,
        name: 'file.read',
        arguments: { path: `${id}.txt` },
      },
    })),
  };
}

function makeInference(responses: readonly ModelResponse[]): {
  readonly inference: InferenceEngine;
  readonly requests: InferenceRequest[];
} {
  const requests: InferenceRequest[] = [];

  const inference: InferenceEngine = {
    stream(request): ModelStream {
      const response = responses[requests.length];

      if (response === undefined) {
        throw new Error('No response configured for inference request.');
      }

      requests.push(request);

      let consumed = false;
      let exhausted = false;

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
          if (consumed) {
            throw new Error('Model stream consumed more than once.');
          }

          consumed = true;

          yield {
            type: 'response.started',
            requestId: response.requestId,
            messageId: response.messageId,
          };

          for (const block of response.blocks) {
            if (block.type === 'toolcall') {
              yield {
                type: 'toolcall.completed',
                requestId: response.requestId,
                messageId: response.messageId,
                blockId: block.id,
                toolCall: block.toolCall,
              };
            }
          }

          exhausted = true;

          yield {
            type:
              response.failure === undefined
                ? 'response.completed'
                : 'response.failed',
            requestId: response.requestId,
            messageId: response.messageId,
            response,
          };
        },

        result(): Promise<ModelResponse> {
          if (!exhausted) {
            return Promise.reject(new Error('Model stream was not exhausted.'));
          }

          return Promise.resolve(response);
        },
      };
    },
  };

  return { inference, requests };
}

function makeGateway(
  execute: ToolExecutionGateway['execute'],
): ToolExecutionGateway {
  return {
    async listModelTools() {
      return [
        {
          name: 'file.read',
          description: 'Read a permitted file.',
          parameters: { type: 'object' },
        },
      ];
    },
    execute,
  };
}

function gate(): {
  readonly promise: Promise<void>;
  readonly open: () => void;
} {
  const state: {
    open: (() => void) | undefined;
  } = { open: undefined };

  const promise = new Promise<void>((resolve) => {
    state.open = resolve;
  });

  if (state.open === undefined) {
    throw new Error('Gate initialization failed.');
  }

  return { promise, open: state.open };
}

describe('Agent public contract conformance', () => {
  it('completes model-tool-model execution with ordered results', async () => {
    const fixture = makeInference([
      toolResponse('request-1', ['A', 'B']),
      finalResponse('request-2'),
    ]);

    const invoked: string[] = [];
    const events: AgentEvent[] = [];

    const agent = createAgent({
      inference: fixture.inference,
      toolGateway: makeGateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        expect(request.modelRequestId).toBe('request-1');

        return {
          status: 'success',
          content: [{ type: 'text', text: 'Content read.' }],
        };
      }),
    });

    const run = agent.start({ message: 'Read both files.', model }, (event) => {
      events.push(event);
    });

    const result = await run.result;

    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['A', 'B']);
    expect(fixture.requests).toHaveLength(2);

    expect(
      fixture.requests[1]?.messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'tool_result', 'tool_result']);

    const toolResults = fixture.requests[1]?.messages.filter(
      (message): message is ToolResultConversationMessage =>
        message.role === 'tool_result',
    );

    expect(
      toolResults?.map((message) => [message.toolCallId, message.isError]),
    ).toEqual([
      ['A', false],
      ['B', false],
    ]);

    expect(agent.getConversation().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'tool_result',
      'assistant',
    ]);

    const types = events.map((event) => event.type);

    expect(types.indexOf('model.request.finished') >= 0).toBe(true);

    expect(
      types.indexOf('tool.dispatch.started') >
        types.indexOf('model.request.finished'),
    ).toBe(true);

    expect(
      events.filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);

    expect(run.state).toEqual({
      kind: 'finished',
      result,
    });
  });

  it('never executes a streamed tool proposal after model failure', async () => {
    const proposal: ModelToolCall = {
      toolCallId: 'A',
      name: 'file.read',
      arguments: { path: 'A.txt' },
    };

    const toolObserved = gate();
    const finishStream = gate();

    const failure: ModelResponse = {
      ...finalResponse('request-failed'),
      finishReason: 'error',
      failure: {
        code: 'provider_error',
        message: 'Provider terminated the stream.',
        retryable: false,
      },
    };

    const inference: InferenceEngine = {
      stream(): ModelStream {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent> {
            yield {
              type: 'response.started',
              requestId: failure.requestId,
              messageId: failure.messageId,
            };

            yield {
              type: 'toolcall.completed',
              requestId: failure.requestId,
              messageId: failure.messageId,
              blockId: 'tool-A',
              toolCall: proposal,
            };

            toolObserved.open();
            await finishStream.promise;

            yield {
              type: 'response.failed',
              requestId: failure.requestId,
              messageId: failure.messageId,
              response: failure,
            };
          },

          result: () => Promise.resolve(failure),
        };
      },
    };

    let calls = 0;

    const agent = createAgent({
      inference,
      toolGateway: makeGateway(async () => {
        calls++;

        return {
          status: 'success',
          content: [],
        };
      }),
    });

    const run = agent.start({
      message: 'Read A.',
      model,
    });

    await toolObserved.promise;

    expect(calls).toBe(0);

    finishStream.open();

    const result = await run.result;

    expect(result.status).toBe('failed');
    expect(calls).toBe(0);
    expect(agent.getConversation()).toEqual([]);
  });

  it('records a rejected tool and skips remaining calls', async () => {
    const fixture = makeInference([
      toolResponse('request-1', ['A', 'B', 'C']),
      finalResponse('request-2'),
    ]);

    const invoked: string[] = [];

    const agent = createAgent({
      inference: fixture.inference,
      toolGateway: makeGateway(async (request) => {
        invoked.push(request.toolCall.toolCallId);

        if (request.toolCall.toolCallId === 'B') {
          return {
            status: 'rejected',
            code: 'permission_denied',
            message: 'Denied.',
          };
        }

        return {
          status: 'success',
          content: [{ type: 'text', text: 'OK' }],
        };
      }),
    });

    const result = await agent.start({
      message: 'Read three files.',
      model,
    }).result;

    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['A', 'B']);

    const toolResults = fixture.requests[1]?.messages.filter(
      (message): message is ToolResultConversationMessage =>
        message.role === 'tool_result',
    );

    expect(
      toolResults?.map((message) => [message.toolCallId, message.isError]),
    ).toEqual([
      ['A', false],
      ['B', true],
      ['C', true],
    ]);

    expect(toolResults?.[2]?.content[0]?.text).toContain('Not executed');
  });

  it('releases run ownership before publishing terminal completion', async () => {
    const fixture = makeInference([
      finalResponse('request-1'),
      finalResponse('request-2'),
    ]);

    const agent = createAgent({
      inference: fixture.inference,
    });

    const state: {
      next: AgentRun | undefined;
    } = { next: undefined };

    const first = agent.start({ message: 'First.', model }, (event) => {
      if (event.type === 'run.finished') {
        state.next = agent.start({
          message: 'Second.',
          model,
        });
      }
    });

    expect((await first.result).status).toBe('completed');

    if (state.next === undefined) {
      throw new Error('Expected a second run to start.');
    }

    expect((await state.next.result).status).toBe('completed');

    expect(
      fixture.requests[1]?.messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'user']);
  });
});
