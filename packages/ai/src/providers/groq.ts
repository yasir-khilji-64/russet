import { envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';

import { groqModelDefinition } from '../models.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

export function groqProvider() {
  const definition = groqModelDefinition;

  const model: Model<'openai-completions'> = {
    id: definition.id.modelId,
    name: definition.name,
    provider: definition.id.providerId,
    api: definition.protocol,
    baseUrl: BASE_URL,

    reasoning: true,
    input: ['text'],

    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.037,
      cacheWrite: 0,
    },

    contextWindow: definition.contextWindow,
    maxTokens: definition.maxOutputTokens,

    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
    },
  };

  return createProvider({
    id: definition.id.providerId,
    name: 'Groq',
    baseUrl: BASE_URL,

    auth: {
      apiKey: envApiKeyAuth('Groq API key', ['GROQ_API_KEY']),
    },

    models: [model],
    api: openAICompletionsApi(),
  });
}
