import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { normalizeUsage } from '../src/inference/usage.js';

type PiUsage = AssistantMessage['usage'];

function createUsage(): PiUsage {
  return {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 10,
    reasoning: 15,
    totalTokens: 180,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.003,
    },
  };
}

describe('inference usage accounting', () => {
  it('preserves token counts', () => {
    const result = normalizeUsage(createUsage());

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(180);
    expect(result.cacheReadTokens).toBe(20);
    expect(result.cacheWriteTokens).toBe(10);
    expect(result.reasoningTokens).toBe(15);
  });

  it('does not double-count reasoning tokens', () => {
    const result = normalizeUsage(createUsage());

    expect(result.outputTokens).toBe(50);
  });

  it('preserves missing reasoning usage', () => {
    const usage = createUsage();
    delete usage.reasoning;

    const result = normalizeUsage(usage);

    expect(result.reasoningTokens).toBeUndefined();
  });

  it('preserves cost values', () => {
    const result = normalizeUsage(createUsage());

    expect(result.totalCostUsd).toBe(0.003);
    expect(result.costSource).toBe('unknown');
  });

  it('recognizes explicit provider cost provenance', () => {
    const usage = createUsage() as PiUsage & {
      cost: PiUsage['cost'] & {
        totalFromProvider?: boolean;
      };
    };

    usage.cost.totalFromProvider = true;

    const result = normalizeUsage(usage);

    expect(result.costSource).toBe('provider_reported');
  });
});
