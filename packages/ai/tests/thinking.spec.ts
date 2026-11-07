import { describe, expect, it } from 'vitest';

import {
  classifyThinking,
  getThinkingAvailability,
  resolveThinkingEffort,
} from '../src/inference/thinking.js';

describe('thinking support', () => {
  const support = {
    available: true,
    supportedEfforts: ['low', 'medium', 'high'],
  } as const;

  it('accepts supported effort levels', () => {
    expect(resolveThinkingEffort({ effort: 'medium' }, support)).toBe('medium');
  });

  it('preserves provider defaults', () => {
    expect(resolveThinkingEffort(undefined, support)).toBeUndefined();
  });

  it('rejects unavailable thinking support', () => {
    expect(() =>
      resolveThinkingEffort(
        { effort: 'high' },
        {
          available: false,
          supportedEfforts: [],
        },
      ),
    ).toThrow();
  });

  it('classifies readable thinking', () => {
    expect(
      classifyThinking({
        thinking: 'Provider-supplied reasoning',
      }),
    ).toBe('visible');
  });

  it('does not expose redacted thinking', () => {
    expect(
      classifyThinking({
        thinking: '',
        redacted: true,
      }),
    ).toBe('opaque');
  });

  it('does not invent reasoning visibility', () => {
    expect(classifyThinking({ thinking: '' })).toBe('unknown');
  });

  it('reports unavailable reasoning output', () => {
    expect(getThinkingAvailability([])).toBe('unavailable');
  });

  it('recognizes opaque reasoning availability', () => {
    expect(getThinkingAvailability([{ thinking: '', redacted: true }])).toBe(
      'available',
    );
  });
});
