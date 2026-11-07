import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { preservePiContinuation } from '../src/inference/continuation.js';
import { buildPiContext } from '../src/inference/conversation.js';
import { toPortablePiAssistant } from '../src/inference/portable.js';
import type { ModelId, ModelResponse } from '../src/inference/types.js';

const ollama: ModelId = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const groq: ModelId = {
  providerId: 'groq',
  modelId: 'openai/gpt-oss-20b',
};

function nativeMessage(model: ModelId): AssistantMessage {
  return {
    role: 'assistant',
    provider: model.providerId,
    model: model.modelId,
    api: 'openai-completions',
    timestamp: 1,
    stopReason: 'stop',
    content: [
      {
        type: 'thinking',
        thinking: 'Private provider thinking.',
        thinkingSignature: 'synthetic-signature',
      },
      {
        type: 'text',
        text: 'The result is 500.',
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
}

function response(model: ModelId = ollama): ModelResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    protocol: 'openai-completions',
    timestamp: 1,
    finishReason: 'stop',
    thinkingAvailability: 'available',
    blocks: [
      {
        id: 'thinking-1',
        type: 'thinking',
        visibility: 'visible',
        text: 'Private provider thinking.',
      },
      {
        id: 'text-1',
        type: 'text',
        text: 'The result is 500.',
      },
    ],
    nativeContinuation: preservePiContinuation(nativeMessage(model)),
  };
}

describe('portable model switching', () => {
  it('preserves assistant text', () => {
    const converted = toPortablePiAssistant(response());

    expect(converted.content).toEqual([
      {
        type: 'text',
        text: 'The result is 500.',
      },
    ]);
  });

  it('removes foreign thinking and signatures', () => {
    const converted = toPortablePiAssistant(response());

    expect(converted.content.some((block) => block.type === 'thinking')).toBe(
      false,
    );

    expect(JSON.stringify(converted)).not.toContain(
      'Private provider thinking.',
    );

    expect(JSON.stringify(converted)).not.toContain('synthetic-signature');
  });

  it('retains native state for compatible continuation', () => {
    const context = buildPiContext(
      {
        model: ollama,
        messages: [
          {
            role: 'user',
            text: 'Calculate 125 + 375.',
          },
          {
            role: 'assistant',
            response: response(ollama),
          },
        ],
      },
      'openai-completions',
    );

    const assistant = context.messages[1];

    if (assistant?.role !== 'assistant') {
      throw new Error('Expected assistant message.');
    }

    expect(assistant.content[0]).toMatchObject({
      type: 'thinking',
      thinkingSignature: 'synthetic-signature',
    });
  });

  for (const [source, target] of [
    [ollama, groq],
    [groq, ollama],
  ] as const) {
    it(`switches from ${source.providerId} to ${target.providerId}`, () => {
      const context = buildPiContext(
        {
          model: target,
          messages: [
            {
              role: 'user',
              text: 'Calculate 125 + 375.',
            },
            {
              role: 'assistant',
              response: response(source),
            },
            {
              role: 'user',
              text: 'Summarize the previous answer.',
            },
          ],
        },
        'openai-completions',
      );

      expect(context.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);

      const assistant = context.messages[1];

      if (assistant?.role !== 'assistant') {
        throw new Error('Expected assistant message.');
      }

      expect(assistant.content).toEqual([
        {
          type: 'text',
          text: 'The result is 500.',
        },
      ]);

      expect(assistant.provider).toBe(source.providerId);
    });
  }

  it('does not restore old native thinking after switching back', () => {
    const context = buildPiContext(
      {
        model: ollama,
        messages: [
          {
            role: 'user',
            text: 'First request',
          },
          {
            role: 'assistant',
            response: response(ollama),
          },
          {
            role: 'user',
            text: 'Second request',
          },
          {
            role: 'assistant',
            response: response(groq),
          },
          {
            role: 'user',
            text: 'Third request',
          },
        ],
      },
      'openai-completions',
    );

    const assistants = context.messages.filter(
      (message) => message.role === 'assistant',
    );

    expect(assistants).toHaveLength(2);

    for (const assistant of assistants) {
      expect(assistant.content.some((block) => block.type === 'thinking')).toBe(
        false,
      );
    }
  });

  it('rejects unsuccessful portable responses', () => {
    expect(() =>
      toPortablePiAssistant({
        ...response(),
        finishReason: 'aborted',
      }),
    ).toThrow();
  });

  it('rejects non-JSON tool arguments', () => {
    const original = response();

    const invalid: ModelResponse = {
      ...original,
      finishReason: 'tool_use',
      blocks: [
        {
          id: 'tool-1',
          type: 'toolcall',
          toolCall: {
            toolCallId: 'call-1',
            name: 'example',
            arguments: {
              value: undefined,
            },
          },
        },
      ],
    };

    expect(() => toPortablePiAssistant(invalid)).toThrow();
  });

  it('rejects cyclic tool arguments', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const original = response();

    expect(() =>
      toPortablePiAssistant({
        ...original,
        finishReason: 'tool_use',
        blocks: [
          {
            id: 'tool-1',
            type: 'toolcall',
            toolCall: {
              toolCallId: 'call-1',
              name: 'example',
              arguments: cyclic,
            },
          },
        ],
      }),
    ).toThrow();
  });
});
