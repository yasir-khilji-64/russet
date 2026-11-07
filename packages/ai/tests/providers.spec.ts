import { createModels } from '@earendil-works/pi-ai/models';
import { describe, expect, it, vi } from 'vitest';

import { createInferenceEngine } from '../src/inference/create.js';
import { groqProvider } from '../src/providers/groq.js';
import { ollamaProvider } from '../src/providers/ollama.js';

function createTestModels() {
  const models = createModels();

  models.setProvider(
    ollamaProvider({
      contextWindow: 8192,
      maxOutputTokens: 2048,
    }),
  );

  models.setProvider(groqProvider());

  return models;
}

describe('inference providers', () => {
  it('registers the selected models', () => {
    const models = createTestModels();

    expect(models.getModels()).toHaveLength(2);

    expect(models.getModel('ollama', 'gpt-oss:20b')).toBeDefined();

    expect(models.getModel('groq', 'openai/gpt-oss-20b')).toBeDefined();
  });

  it('uses OpenAI-compatible inference', () => {
    const models = createTestModels();

    for (const model of models.getModels()) {
      expect(model.api).toBe('openai-completions');
      expect(model.reasoning).toBe(true);
    }
  });

  it('keeps provider endpoints separate', () => {
    const models = createTestModels();

    expect(models.getModel('ollama', 'gpt-oss:20b')?.baseUrl).toBe(
      'http://127.0.0.1:11434/v1',
    );

    expect(models.getModel('groq', 'openai/gpt-oss-20b')?.baseUrl).toBe(
      'https://api.groq.com/openai/v1',
    );
  });

  it('rejects invalid Ollama limits', () => {
    expect(() =>
      ollamaProvider({
        contextWindow: 2048,
        maxOutputTokens: 4096,
      }),
    ).toThrow();
  });

  it('supports keyless Ollama authentication', async () => {
    const models = createTestModels();

    const auth = await models.getAuth('ollama');

    expect(auth).toBeDefined();
    expect(auth?.auth.apiKey).toBe('ollama');
  });

  it('resolves the Groq environment credential', async () => {
    vi.stubEnv('GROQ_API_KEY', 'synthetic-test-key');

    try {
      const models = createTestModels();
      const auth = await models.getAuth('groq');

      expect(auth).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates the inference engine', () => {
    const engine = createInferenceEngine({
      ollama: {
        contextWindow: 8192,
        maxOutputTokens: 2048,
      },
    });

    expect(typeof engine.stream).toBe('function');
  });
});
