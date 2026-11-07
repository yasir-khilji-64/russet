import type { Context, Message, Tool } from '@earendil-works/pi-ai';

import { restorePiContinuation } from './continuation.js';
import type { InferenceRequest, ModelToolDefinition } from './types.js';

interface PendingToolCall {
  id: string;
  name: string;
}

function convertTools(definitions: readonly ModelToolDefinition[]): Tool[] {
  const names = new Set<string>();

  return definitions.map((definition) => {
    if (
      !definition.name.trim() ||
      !definition.description.trim() ||
      names.has(definition.name)
    ) {
      throw new Error('Invalid or duplicate model tool definition.');
    }

    if (definition.parameters.type !== 'object') {
      throw new Error(`Tool "${definition.name}" requires an object schema.`);
    }

    names.add(definition.name);

    return {
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters),
    };
  });
}

export function buildPiContext(
  request: InferenceRequest,
  protocol: string,
): Context {
  const messages: Message[] = [];

  let pending: PendingToolCall[] = [];

  for (const message of request.messages) {
    switch (message.role) {
      case 'user': {
        if (pending.length > 0) {
          throw new Error(
            'Tool results are required before a new user message.',
          );
        }

        messages.push({
          role: 'user',
          content: message.text,
          timestamp: message.timestamp ?? Date.now(),
        });

        break;
      }

      case 'assistant': {
        if (pending.length > 0) {
          throw new Error('Previous tool calls have unresolved results.');
        }

        const response = message.response;

        if (response.failure || !response.nativeContinuation) {
          throw new Error('Assistant response has no usable continuation.');
        }

        if (
          response.model.providerId !== request.model.providerId ||
          response.model.modelId !== request.model.modelId
        ) {
          throw new Error('Cross-model continuation is not enabled yet.');
        }

        const native = restorePiContinuation(response.nativeContinuation, {
          providerId: request.model.providerId,
          modelId: request.model.modelId,
          protocol,
        });

        if (native.stopReason !== 'stop' && native.stopReason !== 'toolUse') {
          throw new Error('Unsupported assistant continuation state.');
        }

        if (
          (native.stopReason === 'toolUse') !==
          (response.finishReason === 'tool_use')
        ) {
          throw new Error('Assistant continuation finish reason mismatch.');
        }

        const calls = native.content.filter(
          (block) => block.type === 'toolCall',
        );

        if ((native.stopReason === 'toolUse') !== calls.length > 0) {
          throw new Error('Assistant tool-call state is inconsistent.');
        }

        const ids = new Set<string>();

        pending = calls.map((call) => {
          if (!call.id || !call.name || ids.has(call.id)) {
            throw new Error('Invalid assistant tool-call identity.');
          }

          ids.add(call.id);

          return {
            id: call.id,
            name: call.name,
          };
        });

        messages.push(native);
        break;
      }

      case 'tool_result': {
        const expected = pending[0];

        if (!expected) {
          throw new Error('Tool result has no pending tool call.');
        }

        if (
          expected.id !== message.toolCallId ||
          expected.name !== message.toolName
        ) {
          throw new Error('Tool result does not match the pending call.');
        }

        messages.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content.map((block) => ({
            type: 'text' as const,
            text: block.text,
          })),
          isError: message.isError,
          timestamp: message.timestamp ?? Date.now(),
        });

        pending.shift();
        break;
      }
    }
  }

  if (pending.length > 0) {
    throw new Error('Cannot continue before all tool results are recorded.');
  }

  return {
    messages,
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: request.systemPrompt }),
    ...(request.tools?.length ? { tools: convertTools(request.tools) } : {}),
  };
}
