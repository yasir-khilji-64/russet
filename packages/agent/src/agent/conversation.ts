import type { ConversationMessage, ModelResponse } from '@russet/ai';

function copyModelResponse(response: ModelResponse): ModelResponse {
  return {
    ...response,
    model: { ...response.model },
    blocks: response.blocks.map((block) => {
      if (block.type !== 'toolcall') {
        return { ...block };
      }

      return {
        ...block,
        toolCall: {
          ...block.toolCall,
          arguments: structuredClone(block.toolCall.arguments),
        },
      };
    }),
    ...(response.usage === undefined ? {} : { usage: { ...response.usage } }),
    ...(response.failure === undefined
      ? {}
      : { failure: { ...response.failure } }),
  };
}

export function snapshotConversation(
  messages: readonly ConversationMessage[],
): readonly ConversationMessage[] {
  return messages.map((message): ConversationMessage => {
    switch (message.role) {
      case 'user':
        return { ...message };

      case 'assistant':
        return {
          role: 'assistant',
          response: copyModelResponse(message.response),
        };

      case 'tool_result':
        return {
          ...message,
          content: message.content.map((block) => ({
            ...block,
          })),
        };
    }
  });
}
