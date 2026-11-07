import { describe, expect, it } from 'vitest';

import { createInferenceEngine } from '../../src/inference/create.js';
import { getCompletedToolCalls } from '../../src/inference/tools.js';
import type {
  InferenceRequest,
  ModelEvent,
  ModelToolDefinition,
} from '../../src/inference/types.js';

const describeLive =
  process.env.RUSSET_AI_LIVE === '1' ? describe : describe.skip;

const models = [
  {
    providerId: 'ollama',
    modelId: 'gpt-oss:20b',
  },
  // {
  //   providerId: 'groq',
  //   modelId: 'openai/gpt-oss-20b',
  // },
] as const;

describeLive('live inference providers', () => {
  const engine = createInferenceEngine({
    ollama: {
      contextWindow: 8192,
      maxOutputTokens: 2048,
    },
  });

  async function infer(request: InferenceRequest) {
    const signal = AbortSignal.timeout(180_000);

    const stream = engine.stream(request, {
      signal,
      ...(request.model.providerId === 'groq'
        ? {
            thinking: {
              effort: 'medium' as const,
            },
          }
        : {}),
    });

    const events: ModelEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    const response = await stream.result();

    expect(response.failure).toBeUndefined();

    return { events, response };
  }

  it('has a configured Groq credential', () => {
    expect(process.env.GROQ_API_KEY).toBeTruthy();
  });

  for (const model of models) {
    it(`streams text through ${model.providerId}`, async () => {
      const { events, response } = await infer({
        model,
        messages: [
          {
            role: 'user',
            text:
              'Explain what a TypeScript interface is ' +
              'in one concise paragraph.',
          },
        ],
      });

      expect(response.finishReason).toBe('stop');

      expect(events.some((event) => event.type === 'text.delta')).toBe(true);

      expect(events.at(-1)?.type).toBe('response.completed');
    }, 210_000);

    it(`streams thinking through ${model.providerId}`, async () => {
      const { events, response } = await infer({
        model,
        messages: [
          {
            role: 'user',
            text:
              'Reason carefully about 37 multiplied by 48. ' +
              'Give the final numerical answer.',
          },
        ],
      });

      expect(response.finishReason).toBe('stop');

      expect(events.some((event) => event.type === 'thinking.started')).toBe(
        true,
      );

      expect(events.some((event) => event.type === 'thinking.completed')).toBe(
        true,
      );

      expect(response.thinkingAvailability).toBe('available');
    }, 210_000);
  }

  const tools: readonly ModelToolDefinition[] = [
    {
      name: 'add_numbers',
      description: 'Add two numbers.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  ];

  for (const model of models) {
    it(`continues after a tool result on ${model.providerId}`, async () => {
      const userMessage = {
        role: 'user' as const,
        text:
          'Call add_numbers with a=125 and b=375. ' +
          'Use the tool result in your final answer.',
      };

      const first = await infer({
        model,
        messages: [userMessage],
        tools,
      });

      expect(first.response.finishReason).toBe('tool_use');

      const calls = getCompletedToolCalls(first.response);

      expect(calls).toHaveLength(1);

      const call = calls[0]!;

      expect(call.name).toBe('add_numbers');

      expect(call.arguments).toEqual({
        a: 125,
        b: 375,
      });

      // The test supplies a synthetic tool result.
      // No tool is executed by @russet/ai.
      const second = await infer({
        model,
        messages: [
          userMessage,
          {
            role: 'assistant',
            response: first.response,
          },
          {
            role: 'tool_result',
            toolCallId: call.toolCallId,
            toolName: call.name,
            content: [
              {
                type: 'text',
                text: '500',
              },
            ],
            isError: false,
          },
        ],
        tools,
      });

      expect(second.response.finishReason).toBe('stop');

      const answer = second.response.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      expect(answer).toContain('500');
    }, 300_000);
  }
});
