import { describe, expect, it } from 'vitest';

import { createInferenceEngine } from '../../src/inference/create.js';
import type { InferenceRequest, ModelId } from '../../src/inference/types.js';

const describeLive =
  process.env.RUSSET_AI_LIVE === '1' ? describe : describe.skip;

const ollama: ModelId = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const groq: ModelId = {
  providerId: 'groq',
  modelId: 'openai/gpt-oss-20b',
};

describeLive('live model switching', () => {
  const engine = createInferenceEngine({
    ollama: {
      contextWindow: 8192,
      maxOutputTokens: 2048,
    },
  });

  async function infer(request: InferenceRequest) {
    const stream = engine.stream(request, {
      signal: AbortSignal.timeout(180_000),
      ...(request.model.providerId === 'groq'
        ? {
            thinking: {
              effort: 'medium' as const,
            },
          }
        : {}),
    });

    // oxlint-disable-next-line no-unused-vars
    for await (const event of stream) {
    }

    const response = await stream.result();

    expect(response.failure).toBeUndefined();
    expect(response.finishReason).toBe('stop');

    return response;
  }

  for (const [source, target] of [
    [ollama, groq],
    [groq, ollama],
  ] as const) {
    it(`continues from ${source.providerId} to ${target.providerId}`, async () => {
      const userMessage = {
        role: 'user' as const,
        text:
          'Explain the purpose of a TypeScript interface ' +
          'in two sentences.',
      };

      const first = await infer({
        model: source,
        messages: [userMessage],
      });

      const second = await infer({
        model: target,
        messages: [
          userMessage,
          {
            role: 'assistant',
            response: first,
          },
          {
            role: 'user',
            text: 'Summarize your previous answer in one sentence.',
          },
        ],
      });

      expect(second.model).toEqual(target);

      expect(second.blocks.some((block) => block.type === 'text')).toBe(true);
    }, 240_000);
  }
});
