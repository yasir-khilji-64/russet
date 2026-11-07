import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { preservePiContinuation } from '../src/inference/continuation.js';
import { buildPiContext } from '../src/inference/conversation.js';
import type {
  InferenceRequest,
  ModelResponse,
} from '../src/inference/types.js';

const model = {
  providerId: 'ollama',
  modelId: 'gpt-oss:20b',
};

const native: AssistantMessage = {
  role: 'assistant',
  provider: 'ollama',
  model: 'gpt-oss:20b',
  api: 'openai-completions',
  stopReason: 'toolUse',
  timestamp: 1,
  content: [
    {
      type: 'thinking',
      thinking: 'Use the arithmetic tool.',
      thinkingSignature: 'synthetic-signature',
    },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'add_numbers',
      arguments: { a: 125, b: 375 },
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

function assistantResponse(): ModelResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model,
    finishReason: 'tool_use',
    thinkingAvailability: 'available',
    blocks: [
      {
        id: 'block-1',
        type: 'toolcall',
        toolCall: {
          toolCallId: 'call-1',
          name: 'add_numbers',
          arguments: { a: 125, b: 375 },
        },
      },
    ],
    nativeContinuation: preservePiContinuation(native),
  };
}

function continuationRequest(): InferenceRequest {
  return {
    model,
    messages: [
      {
        role: 'user',
        text: 'What is 125 + 375?',
      },
      {
        role: 'assistant',
        response: assistantResponse(),
      },
      {
        role: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'add_numbers',
        content: [{ type: 'text', text: '500' }],
        isError: false,
      },
    ],
  };
}

describe('conversation continuation', () => {
  it('preserves the correct message order', () => {
    const context = buildPiContext(continuationRequest(), 'openai-completions');

    expect(context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
    ]);
  });

  it('preserves native thinking signatures', () => {
    const context = buildPiContext(continuationRequest(), 'openai-completions');

    const assistant = context.messages[1];

    expect(assistant?.role).toBe('assistant');

    if (assistant?.role !== 'assistant') {
      throw new Error('Expected an assistant message.');
    }

    expect(assistant.content[0]).toMatchObject({
      type: 'thinking',
      thinkingSignature: 'synthetic-signature',
    });
  });

  it('preserves tool-result correlation', () => {
    const context = buildPiContext(continuationRequest(), 'openai-completions');

    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'add_numbers',
      isError: false,
    });
  });

  it('rejects a mismatched tool result', () => {
    const request = continuationRequest();

    const messages = [...request.messages];

    messages[2] = {
      role: 'tool_result',
      toolCallId: 'wrong-call',
      toolName: 'add_numbers',
      content: [{ type: 'text', text: '500' }],
      isError: false,
    };

    expect(() =>
      buildPiContext({ ...request, messages }, 'openai-completions'),
    ).toThrow();
  });

  it('rejects missing tool results', () => {
    const request = continuationRequest();

    expect(() =>
      buildPiContext(
        {
          ...request,
          messages: request.messages.slice(0, 2),
        },
        'openai-completions',
      ),
    ).toThrow();
  });

  it('rejects incompatible provider continuation', () => {
    const request = continuationRequest();

    expect(() =>
      buildPiContext(
        {
          ...request,
          model: {
            providerId: 'groq',
            modelId: 'openai/gpt-oss-20b',
          },
        },
        'openai-completions',
      ),
    ).toThrow();
  });

  it('preserves failed tool outcomes', () => {
    const request = continuationRequest();

    const messages = [...request.messages];

    messages[2] = {
      role: 'tool_result',
      toolCallId: 'call-1',
      toolName: 'add_numbers',
      content: [
        {
          type: 'text',
          text: 'Tool execution was denied.',
        },
      ],
      isError: true,
    };

    const context = buildPiContext(
      { ...request, messages },
      'openai-completions',
    );

    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      isError: true,
    });
  });
});
