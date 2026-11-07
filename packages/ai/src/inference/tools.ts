import type { ModelResponse, ModelToolCall } from './types.js';

export function getCompletedToolCalls(
  response: ModelResponse,
): readonly ModelToolCall[] {
  if (response.finishReason !== 'tool_use' || response.failure) {
    return [];
  }

  const calls = response.blocks
    .filter((block) => block.type === 'toolcall')
    .map((block) => block.toolCall);

  if (calls.length === 0) {
    throw new Error('Tool-use response contains no completed tool calls');
  }

  const ids = new Set<string>();

  for (const call of calls) {
    if (!call.toolCallId || !call.name || ids.has(call.toolCallId)) {
      throw new Error('Invalid or duplicate model tool-call identity');
    }
    ids.add(call.toolCallId);
  }

  return calls.map((call) => {
    return {
      ...call,
      arguments: structuredClone(call.arguments),
    };
  });
}
