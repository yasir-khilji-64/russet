import type { Context, Message, Tool } from '@earendil-works/pi-ai';

import { restorePiContinuation } from './continuation.js';
import { toPortablePiAssistant } from './portable.js';
import type {
  InferenceRequest,
  ModelResponse,
  ModelToolDefinition,
} from './types.js';

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

function sameModel(
  response: ModelResponse,
  request: InferenceRequest,
  protocol: string,
): boolean {
  return (
    response.model.providerId === request.model.providerId &&
    response.model.modelId === request.model.modelId &&
    (response.protocol === undefined || response.protocol === protocol)
  );
}

function lastForeignAssistantIndex(
  request: InferenceRequest,
  protocol: string,
): number {
  let lastForeign = -1;

  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index];

    if (
      message?.role === 'assistant' &&
      !sameModel(message.response, request, protocol)
    ) {
      lastForeign = index;
    }
  }

  return lastForeign;
}

export function buildPiContext(
  request: InferenceRequest,
  protocol: string,
): Context {
  const messages: Message[] = [];
  const foreignBoundary = lastForeignAssistantIndex(request, protocol);

  let pending: PendingToolCall[] = [];

  for (const [index, message] of request.messages.entries()) {
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

        if (
          response.failure ||
          (response.finishReason !== 'stop' &&
            response.finishReason !== 'tool_use')
        ) {
          throw new Error(
            'Cannot continue an unsuccessful assistant response.',
          );
        }

        const useNative =
          sameModel(response, request, protocol) && index > foreignBoundary;

        const assistant = useNative
          ? (() => {
              if (!response.nativeContinuation) {
                throw new Error(
                  'Compatible native continuation is unavailable.',
                );
              }

              return restorePiContinuation(response.nativeContinuation, {
                providerId: request.model.providerId,
                modelId: request.model.modelId,
                protocol,
              });
            })()
          : toPortablePiAssistant(response);

        if (
          assistant.stopReason !== 'stop' &&
          assistant.stopReason !== 'toolUse'
        ) {
          throw new Error('Unsupported assistant continuation state.');
        }

        if (
          (assistant.stopReason === 'toolUse') !==
          (response.finishReason === 'tool_use')
        ) {
          throw new Error('Assistant finish reason mismatch.');
        }

        const calls = assistant.content.filter(
          (block) => block.type === 'toolCall',
        );

        if ((assistant.stopReason === 'toolUse') !== calls.length > 0) {
          throw new Error('Assistant tool-call state is inconsistent.');
        }

        const ids = new Set<string>();

        pending = calls.map((call) => {
          if (
            !call.id ||
            !call.name ||
            call.argumentsError ||
            ids.has(call.id)
          ) {
            throw new Error(
              'Invalid assistant tool-call identity or arguments.',
            );
          }

          ids.add(call.id);

          return {
            id: call.id,
            name: call.name,
          };
        });

        messages.push(assistant);
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
