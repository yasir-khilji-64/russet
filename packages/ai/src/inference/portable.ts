import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';

import type { JsonObject, JsonValue, ModelResponse } from './types.js';

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  budget: { remaining: number },
): value is JsonValue {
  if (--budget.remaining < 0 || depth > MAX_JSON_DEPTH) {
    return false;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );

        if (
          !descriptor ||
          !('value' in descriptor) ||
          !isJsonValue(descriptor.value, ancestors, depth + 1, budget)
        ) {
          return false;
        }
      }

      return true;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const descriptor of Object.values(descriptors)) {
      if (
        !('value' in descriptor) ||
        !isJsonValue(descriptor.value, ancestors, depth + 1, budget)
      ) {
        return false;
      }
    }

    return true;
  } finally {
    ancestors.delete(value);
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return isJsonValue(value, new WeakSet<object>(), 0, {
    remaining: MAX_JSON_NODES,
  });
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function toPortablePiAssistant(
  response: ModelResponse,
): AssistantMessage {
  if (
    response.failure ||
    (response.finishReason !== 'stop' && response.finishReason !== 'tool_use')
  ) {
    throw new Error('Cannot transfer an unsuccessful assistant response.');
  }

  if (!response.protocol) {
    throw new Error('Assistant response has no source protocol.');
  }

  const content: AssistantMessage['content'] = [];
  const toolCallIds = new Set<string>();

  for (const block of response.blocks) {
    if (block.type === 'thinking') {
      continue;
    }

    if (block.type === 'text') {
      content.push({
        type: 'text',
        text: block.text,
      });

      continue;
    }

    const call = block.toolCall;

    if (
      !call.toolCallId ||
      !call.name ||
      call.argumentsError ||
      !isJsonObject(call.arguments) ||
      toolCallIds.has(call.toolCallId)
    ) {
      throw new Error('Invalid portable tool-call representation.');
    }

    toolCallIds.add(call.toolCallId);

    const toolCall: ToolCall = {
      type: 'toolCall',
      id: call.toolCallId,
      name: call.name,
      arguments: structuredClone(call.arguments),
    };

    content.push(toolCall);
  }

  if ((response.finishReason === 'tool_use') !== toolCallIds.size > 0) {
    throw new Error('Portable tool calls do not match the finish reason.');
  }

  return {
    role: 'assistant',
    provider: response.model.providerId,
    model: response.model.modelId,
    api: response.protocol,
    content,
    stopReason: response.finishReason === 'tool_use' ? 'toolUse' : 'stop',
    timestamp: response.timestamp ?? Date.now(),
    usage: emptyUsage(),
  };
}
