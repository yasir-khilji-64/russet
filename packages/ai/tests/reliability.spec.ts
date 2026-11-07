import type {
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { createPiInferenceEngine } from '../src/inference/pi.js';
import { getCompletedToolCalls } from '../src/inference/tools.js';
import type {
  InferenceRequest,
  ModelEvent,
  ModelResponse,
} from '../src/inference/types.js';

const request: InferenceRequest = {
  model: {
    providerId: 'ollama',
    modelId: 'gpt-oss:20b',
  },
  messages: [
    {
      role: 'user',
      text: 'Explain TypeScript interfaces.',
    },
  ],
};

function assistant(
  stopReason: AssistantMessage['stopReason'],
  text = '',
): AssistantMessage {
  return {
    role: 'assistant',
    provider: 'ollama',
    model: 'gpt-oss:20b',
    api: 'openai-completions',
    timestamp: 1,
    stopReason,
    content: [
      {
        type: 'text',
        text,
      },
    ],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}

function mockModels(
  events: readonly AssistantMessageEvent[],
  final: AssistantMessage,
  onRequest?: () => void,
) {
  return {
    getModel: () => ({
      id: 'gpt-oss:20b',
      provider: 'ollama',
      api: 'openai-completions',
      reasoning: true,
    }),

    streamSimple: () => {
      onRequest?.();

      return {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        result: async () => final,
      };
    },
  } as unknown as Parameters<typeof createPiInferenceEngine>[0];
}

async function consume(
  events: readonly AssistantMessageEvent[],
  final: AssistantMessage,
) {
  const engine = createPiInferenceEngine(mockModels(events, final));

  const stream = engine.stream(request);
  const received: ModelEvent[] = [];

  for await (const event of stream) {
    received.push(event);
  }

  return {
    received,
    response: await stream.result(),
  };
}

describe('inference reliability', () => {
  it('preserves partial text after a provider failure', async () => {
    const partial = assistant('pending', 'Partial response');

    const failed = assistant('error', 'Partial response');

    const events: AssistantMessageEvent[] = [
      {
        type: 'start',
        partial,
      },
      {
        type: 'text_start',
        contentIndex: 0,
        partial,
      },
      {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Partial response',
        partial,
      },
      {
        type: 'error',
        reason: 'error',
        error: failed,
      },
    ];

    const { received, response } = await consume(events, failed);

    expect(response.finishReason).toBe('error');
    expect(response.failure?.code).toBe('provider_error');

    expect(response.blocks).toMatchObject([
      {
        type: 'text',
        text: 'Partial response',
      },
    ]);

    expect(received.at(-1)?.type).toBe('response.failed');
  });

  it('handles an error before response start', async () => {
    const failed = assistant('error');

    const { received, response } = await consume(
      [
        {
          type: 'error',
          reason: 'error',
          error: failed,
        },
      ],
      failed,
    );

    expect(response.failure?.code).toBe('provider_error');

    expect(received.some((event) => event.type === 'response.started')).toBe(
      false,
    );
  });

  it('rejects streams without terminal events', async () => {
    const partial = assistant('pending', 'Hello');

    const { response } = await consume(
      [
        {
          type: 'start',
          partial,
        },
        {
          type: 'text_start',
          contentIndex: 0,
          partial,
        },
        {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Hello',
          partial,
        },
      ],
      partial,
    );

    expect(response.failure?.code).toBe('invalid_response');

    expect(response.blocks).toMatchObject([
      {
        type: 'text',
        text: 'Hello',
      },
    ]);
  });

  it('aborts before starting provider inference', async () => {
    const controller = new AbortController();

    controller.abort();

    let dispatched = false;

    const engine = createPiInferenceEngine(
      mockModels([], assistant('aborted'), () => {
        dispatched = true;
      }),
    );

    const stream = engine.stream(request, {
      signal: controller.signal,
    });

    // oxlint-disable-next-line no-unused-vars
    for await (const event of stream) {
    }

    const response = await stream.result();

    expect(dispatched).toBe(false);
    expect(response.finishReason).toBe('aborted');
    expect(response.failure?.code).toBe('cancelled');
  });

  it('settles when the consumer closes early', async () => {
    const partial = assistant('pending');

    const engine = createPiInferenceEngine(
      mockModels(
        [
          {
            type: 'start',
            partial,
          },
          {
            type: 'text_start',
            contentIndex: 0,
            partial,
          },
        ],
        partial,
      ),
    );

    const stream = engine.stream(request);

    for await (const event of stream) {
      if (event.type === 'response.started') {
        break;
      }
    }

    const response = await stream.result();

    expect(response.finishReason).toBe('aborted');
    expect(response.failure?.code).toBe('stream_closed');
  });

  it('rejects result retrieval before consumption', async () => {
    const engine = createPiInferenceEngine(mockModels([], assistant('stop')));

    const stream = engine.stream(request);

    await expect(stream.result()).rejects.toThrow('Consume the model stream');
  });

  it('rejects malformed completed tool arguments', () => {
    const response: ModelResponse = {
      requestId: 'request-1',
      messageId: 'message-1',
      model: request.model,
      finishReason: 'tool_use',
      thinkingAvailability: 'unavailable',
      blocks: [
        {
          id: 'block-1',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'add_numbers',
            arguments: {},
            argumentsError: 'Invalid JSON arguments.',
          },
        },
      ],
    };

    expect(() => getCompletedToolCalls(response)).toThrow();
  });

  it('never dispatches tools from a failed response', () => {
    const response: ModelResponse = {
      requestId: 'request-1',
      messageId: 'message-1',
      model: request.model,
      finishReason: 'error',
      thinkingAvailability: 'unavailable',
      blocks: [
        {
          id: 'block-1',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'add_numbers',
            arguments: {
              a: 125,
              b: 375,
            },
          },
        },
      ],
      failure: {
        code: 'provider_error',
        message: 'Inference failed.',
        retryable: false,
      },
    };

    expect(getCompletedToolCalls(response)).toEqual([]);
  });
});
