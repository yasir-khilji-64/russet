import { isJsonObject } from './portable.js';
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
    throw new Error('Tool-use response contains no completed tool calls.');
  }

  const ids = new Set<string>();

  for (const call of calls) {
    if (
      !call.toolCallId.trim() ||
      !call.name.trim() ||
      call.argumentsError !== undefined ||
      !isJsonObject(call.arguments) ||
      ids.has(call.toolCallId)
    ) {
      throw new Error('Invalid or duplicate completed tool call.');
    }

    ids.add(call.toolCallId);
  }

  return calls.map((call) => ({
    ...call,
    arguments: structuredClone(call.arguments),
  }));
}
