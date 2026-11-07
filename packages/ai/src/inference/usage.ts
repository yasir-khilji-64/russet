import type { AssistantMessage } from '@earendil-works/pi-ai';

import type { ModelUsage } from './types.js';

type PiUsage = AssistantMessage['usage'];

interface CostProvenance {
  totalFromProvider?: unknown;
}

export function normalizeUsage(usage: PiUsage): ModelUsage {
  const cost = usage.cost as PiUsage['cost'] & CostProvenance;

  let costSource: ModelUsage['costSource'] = 'unknown';

  if (cost.totalFromProvider === true) {
    costSource = 'provider_reported';
  } else if (cost.totalFromProvider === false) {
    costSource = 'catalog_estimate';
  }

  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,

    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: usage.reasoning }),

    totalCostUsd: usage.cost.total,
    costSource,
  };
}
