import { describe, expect, it } from 'vitest';

import { getCompletedToolCalls } from '../src/inference/tools.js';
import type { ModelResponse } from '../src/inference/types.js';

function response(finishReason: ModelResponse['finishReason']): ModelResponse {
  return {
    requestId: 'request-1',
    messageId: 'message-1',
    model: {
      providerId: 'ollama',
      modelId: 'gpt-oss:20b',
    },
    finishReason,
    thinkingAvailability: 'unavailable',
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
  };
}

describe('completed tool proposals', () => {
  it('returns complete calls after tool-use completion', () => {
    const calls = getCompletedToolCalls(response('tool_use'));

    expect(calls).toEqual([
      {
        toolCallId: 'call-1',
        name: 'add_numbers',
        arguments: { a: 125, b: 375 },
      },
    ]);
  });

  it('rejects truncated tool-use responses', () => {
    expect(getCompletedToolCalls(response('length'))).toEqual([]);
  });

  it('does not expose tools from failed responses', () => {
    expect(getCompletedToolCalls(response('error'))).toEqual([]);

    expect(getCompletedToolCalls(response('aborted'))).toEqual([]);
  });

  it('rejects duplicate tool-call IDs', () => {
    const original = response('tool_use');

    expect(() =>
      getCompletedToolCalls({
        ...original,
        blocks: [
          ...original.blocks,
          {
            id: 'block-2',
            type: 'toolcall',
            toolCall: {
              toolCallId: 'call-1',
              name: 'another_tool',
              arguments: {},
            },
          },
        ],
      }),
    ).toThrow();
  });
});
