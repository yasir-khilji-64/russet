import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { createPiInferenceEngine } from '../src/inference/pi.js';
import { getCompletedToolCalls } from '../src/inference/tools.js';
import type {
  InferenceRequest,
  ModelEvent,
  ModelToolDefinition,
} from '../src/inference/types.js';

describe('inference conformance', () => {
  it('streams thinking, requests a tool, and continues', async () => {
    const faux = fauxProvider();
    const models = createModels();

    models.setProvider(faux.provider);

    const model = faux.getModel();

    if (!model) {
      throw new Error('Faux model is unavailable.');
    }

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking('I should use the arithmetic tool.'),
          fauxToolCall('add_numbers', {
            a: 125,
            b: 375,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('The result is 500.')]),
    ]);

    const engine = createPiInferenceEngine(models);

    const modelId = {
      providerId: model.provider,
      modelId: model.id,
    };

    const userMessage = {
      role: 'user' as const,
      text: 'Add 125 and 375 using the provided tool.',
    };

    const tools: ModelToolDefinition[] = [
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

    async function infer(request: InferenceRequest) {
      const stream = engine.stream(request);
      const events: ModelEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      return {
        events,
        response: await stream.result(),
      };
    }

    // First inference: thinking and tool request.
    const first = await infer({
      model: modelId,
      messages: [userMessage],
      tools,
    });

    expect(first.response.failure).toBeUndefined();
    expect(first.response.finishReason).toBe('tool_use');

    expect(
      first.events.some((event) => event.type === 'thinking.started'),
    ).toBe(true);

    expect(
      first.events.some((event) => event.type === 'thinking.completed'),
    ).toBe(true);

    expect(first.events.at(-1)?.type).toBe('response.completed');

    // Every block retains its identity through completion.
    const startedBlockIds = first.events
      .filter((event) =>
        ['text.started', 'thinking.started', 'toolcall.started'].includes(
          event.type,
        ),
      )
      .map((event) => 'blockId' in event && event.blockId);

    const responseBlockIds = first.response.blocks.map((block) => block.id);

    expect(responseBlockIds).toEqual(startedBlockIds);

    const calls = getCompletedToolCalls(first.response);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('add_numbers');
    expect(calls[0]?.arguments).toEqual({
      a: 125,
      b: 375,
    });

    // This is a synthetic result supplied by the test.
    // @russet/ai never executes the tool.
    const second = await infer({
      model: modelId,
      messages: [
        userMessage,
        {
          role: 'assistant',
          response: first.response,
        },
        {
          role: 'tool_result',
          toolCallId: calls[0]!.toolCallId,
          toolName: calls[0]!.name,
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

    expect(second.response.failure).toBeUndefined();
    expect(second.response.finishReason).toBe('stop');

    const answer = second.response.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    expect(answer).toContain('500');

    // Exactly two model requests, no agent loop.
    expect(faux.state.callCount).toBe(2);
  });
});
