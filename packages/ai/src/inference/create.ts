import { createModels } from '@earendil-works/pi-ai/models';

import { groqProvider } from '../providers/groq.js';
import {
  ollamaProvider,
  type OllamaModelOptions,
} from '../providers/ollama.js';
import { createPiInferenceEngine } from './pi.js';
import type { InferenceEngine } from './types.js';

export interface InferenceEngineConfig {
  ollama: OllamaModelOptions;
}

export function createInferenceEngine(
  config: InferenceEngineConfig,
): InferenceEngine {
  const models = createModels();

  models.setProvider(ollamaProvider(config.ollama));

  models.setProvider(groqProvider());

  return createPiInferenceEngine(models, undefined, (model) => {
    if (model.providerId === 'groq' && model.modelId === 'openai/gpt-oss-20b') {
      return {
        available: true,
        supportedEfforts: ['low', 'medium', 'high'],
      };
    }

    if (model.providerId === 'ollama' && model.modelId === 'gpt-oss:20b') {
      return {
        available: true,
        supportedEfforts: [],
      };
    }

    return undefined;
  });
}
