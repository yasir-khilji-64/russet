export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface ModelDefinition {
  id: {
    providerId: string;
    modelId: string;
  };
  name: string;
  protocol: 'openai-completions';
  capabilities: {
    toolCalling: CapabilityState;
    thinking: CapabilityState;
    imageInput: CapabilityState;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
}

export const ollamaModelDefinition = {
  id: {
    providerId: 'ollama',
    modelId: 'gpt-oss:20b',
  },
  name: 'GPT-OSS 20B (Ollama)',
  protocol: 'openai-completions',
  capabilities: {
    toolCalling: 'supported',
    thinking: 'supported',
    imageInput: 'unknown',
  },
} as const satisfies ModelDefinition;

export const groqModelDefinition = {
  id: {
    providerId: 'groq',
    modelId: 'openai/gpt-oss-20b',
  },
  name: 'GPT-OSS 20B (Groq)',
  protocol: 'openai-completions',
  capabilities: {
    toolCalling: 'supported',
    thinking: 'supported',
    imageInput: 'unsupported',
  },
  contextWindow: 131072,
  maxOutputTokens: 65536,
} as const satisfies ModelDefinition;

export const modelDefinitions: readonly ModelDefinition[] = [
  ollamaModelDefinition,
  groqModelDefinition,
];
