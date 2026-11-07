import type { AssistantMessage } from '@earendil-works/pi-ai';

import type { NativeContinuation } from './types.js';

const messages = new WeakMap<NativeContinuation, AssistantMessage>();

export function preservePiContinuation(
  message: AssistantMessage,
): NativeContinuation {
  const handle: NativeContinuation = Object.freeze({
    format: 'pi-ai/in-memory-v1',
    providerId: message.provider,
    modelId: message.model,
    protocol: message.api,
  });

  messages.set(handle, structuredClone(message));
  return handle;
}

export function restorePiContinuation(
  handle: NativeContinuation,
  expected: {
    providerId: string;
    modelId: string;
    protocol: string;
  },
): AssistantMessage {
  if (
    handle.providerId !== expected.providerId ||
    handle.modelId !== expected.modelId ||
    handle.protocol !== expected.protocol
  ) {
    throw new Error('Provider-native continuation is incompatible');
  }

  const message = messages.get(handle);
  if (!message) {
    throw new Error('Provider-native continuation is unavailable');
  }

  return structuredClone(message);
}
