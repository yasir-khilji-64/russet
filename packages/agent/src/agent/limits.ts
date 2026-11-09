import type { AgentExecutionLimits } from './types.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEFAULT_AGENT_EXECUTION_LIMITS: Readonly<AgentExecutionLimits> =
  Object.freeze({
    maxModelRequests: 16,
    maxToolAttempts: 40,
    maxCancellationWaitMs: 5_000,
  });

export function resolveAgentExecutionLimits(
  overrides: Partial<AgentExecutionLimits> | undefined,
): Readonly<AgentExecutionLimits> {
  const limits: AgentExecutionLimits = {
    maxModelRequests:
      overrides?.maxModelRequests ??
      DEFAULT_AGENT_EXECUTION_LIMITS.maxModelRequests,

    maxToolAttempts:
      overrides?.maxToolAttempts ??
      DEFAULT_AGENT_EXECUTION_LIMITS.maxToolAttempts,

    maxCancellationWaitMs:
      overrides?.maxCancellationWaitMs ??
      DEFAULT_AGENT_EXECUTION_LIMITS.maxCancellationWaitMs,
  };

  for (const name of ['maxModelRequests', 'maxToolAttempts'] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }

  if (
    !Number.isSafeInteger(limits.maxCancellationWaitMs) ||
    limits.maxCancellationWaitMs < 0 ||
    limits.maxCancellationWaitMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `maxCancellationWaitMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}.`,
    );
  }

  return Object.freeze(limits);
}
