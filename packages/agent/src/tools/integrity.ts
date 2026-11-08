import type { ConversationMessage, ModelToolCall } from '@russet/ai';

export function assertToolBatchIntegrity(
  calls: readonly ModelToolCall[],
  conversation: readonly ConversationMessage[],
  firstResultIndex: number,
): void {
  if (
    !Number.isSafeInteger(firstResultIndex) ||
    firstResultIndex < 0 ||
    conversation.length - firstResultIndex !== calls.length
  ) {
    throw new Error('Tool batch result count does not match the proposals.');
  }

  for (const [index, call] of calls.entries()) {
    const message = conversation[firstResultIndex + index];

    if (
      message?.role !== 'tool_result' ||
      message.toolCallId !== call.toolCallId ||
      message.toolName !== call.name ||
      typeof message.isError !== 'boolean' ||
      !Array.isArray(message.content) ||
      message.content.some(
        (block) => block.type !== 'text' || typeof block.text !== 'string',
      )
    ) {
      throw new Error(
        `Tool result does not match completed proposal ${index + 1}.`,
      );
    }
  }
}
