import type {
  ThinkingAvailability,
  ThinkingEffort,
  ThinkingOptions,
  ThinkingSupport,
  ThinkingVisibility,
} from './types.js';

export interface ThinkingContent {
  thinking: string;
  redacted?: boolean;
}

export function resolveThinkingEffort(
  options: ThinkingOptions | undefined,
  support: ThinkingSupport | undefined,
): ThinkingEffort | undefined {
  const effort = options?.effort;
  if (effort === undefined) {
    return undefined;
  }
  if (!support?.available) {
    throw new Error('Thinking is not supported by the selected model');
  }
  if (!support.supportedEfforts.includes(effort)) {
    throw new Error(`Unsupported thinking effort: ${effort}`);
  }

  return effort;
}

export function classifyThinking(content: ThinkingContent): ThinkingVisibility {
  if (content.redacted) {
    return 'opaque';
  }
  if (content.thinking.length > 0) {
    return 'visible';
  }
  return 'unknown';
}

export function getThinkingAvailability(
  blocks: readonly ThinkingContent[],
): ThinkingAvailability {
  return blocks.some(
    (block) => block.redacted === true || block.thinking.length > 0,
  )
    ? 'available'
    : 'unavailable';
}
