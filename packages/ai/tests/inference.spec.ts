import type {
  AssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { createPiInferenceEngine } from '../src/inference/pi.js';

describe('Pi inference adapter', () => {
  it('preserves separate events and stable block IDs', async () => {
    const final: AssistantMessage = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'ollama',
      model: 'gpt-oss:20b',
      timestamp: 0,
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'Compute' },
        { type: 'text', text: 'Calling tool' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'add',
          arguments: { a: 20, b: 22 },
        },
      ],
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    };

    const partial: AssistantMessage = {
      ...final,
      stopReason: 'pending',
    };

    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'thinking_start', contentIndex: 0, partial },
      {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'Compute',
        partial,
      },
      {
        type: 'thinking_end',
        contentIndex: 0,
        content: 'Compute',
        partial,
      },
      { type: 'text_start', contentIndex: 1, partial },
      {
        type: 'text_delta',
        contentIndex: 1,
        delta: 'Calling tool',
        partial,
      },
      {
        type: 'text_end',
        contentIndex: 1,
        content: 'Calling tool',
        partial,
      },
      { type: 'toolcall_start', contentIndex: 2, partial },
      {
        type: 'toolcall_delta',
        contentIndex: 2,
        delta: '{"a":20,"b":22}',
        partial,
      },
      {
        type: 'toolcall_end',
        contentIndex: 2,
        toolCall: final.content[2] as Extract<
          AssistantMessage['content'][number],
          { type: 'toolCall' }
        >,
        partial,
      },
      { type: 'done', reason: 'toolUse', message: final },
    ];

    const models = {
      getModel: () => ({ id: 'gpt-oss:20b' }),
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        result: async () => final,
      }),
    } as unknown as Parameters<typeof createPiInferenceEngine>[0];

    let sequence = 0;

    const engine = createPiInferenceEngine(models, () => `id-${++sequence}`);

    const stream = engine.stream({
      model: {
        providerId: 'ollama',
        modelId: 'gpt-oss:20b',
      },
      messages: [{ role: 'user', text: 'Add two numbers' }],
    });

    const received = [];

    for await (const event of stream) {
      received.push(event);
    }

    const response = await stream.result();

    expect(received.map((event) => event.type)).toEqual([
      'response.started',
      'thinking.started',
      'thinking.delta',
      'thinking.completed',
      'text.started',
      'text.delta',
      'text.completed',
      'toolcall.started',
      'toolcall.arguments.delta',
      'toolcall.completed',
      'response.completed',
    ]);

    expect(response.finishReason).toBe('tool_use');

    expect(response.blocks.map((block) => block.id)).toEqual([
      'id-3',
      'id-4',
      'id-5',
    ]);

    expect(received.at(-1)?.type).toBe('response.completed');
  });
});
