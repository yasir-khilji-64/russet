import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';

import { ollamaModelDefinition } from '../models.js';

const BASE_URL = 'http://127.0.0.1:11434/v1';

export interface OllamaModelOptions {
  contextWindow: number;
  maxOutputTokens: number;
}

export function ollamaProvider(options: OllamaModelOptions) {
  const { contextWindow, maxOutputTokens } = options;

  if (
    !Number.isSafeInteger(contextWindow) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    contextWindow <= maxOutputTokens
  ) {
    throw new Error('Invalid model limits');
  }

  const definition = ollamaModelDefinition;
  const model: Model<'openai-completions'> = {
    id: definition.id.modelId,
    name: definition.name,
    provider: definition.id.providerId,
    api: definition.protocol,
    baseUrl: BASE_URL,
    reasoning: true,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: contextWindow,
    maxTokens: maxOutputTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
    },
  };

  return createProvider({
    id: definition.id.providerId,
    name: 'Ollama',
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: 'Ollama',
        resolve: async () => ({
          auth: { apiKey: 'ollama' },
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}
