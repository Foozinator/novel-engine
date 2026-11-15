import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@domain/types';
import { EMPTY_STREAM_USAGE, addStreamUsage, pickStreamUsage } from './streamUsage';

describe('addStreamUsage', () => {
  it('adds token counts, reading missing cache counts as 0', () => {
    const sum = addStreamUsage(
      { inputTokens: 1, outputTokens: 2, thinkingTokens: 3, cacheReadTokens: 4, costUsd: 0.1 },
      { inputTokens: 10, outputTokens: 20, thinkingTokens: 30, cacheWriteTokens: 5, costUsd: 0.2 },
    );
    expect(sum).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      thinkingTokens: 33,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
    });
    expect(sum.costUsd).toBeCloseTo(0.3, 10);
  });

  it('keeps the cost only while both sides report one', () => {
    const priced = { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, costUsd: 0.5 };
    const unpriced = { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 };
    expect(addStreamUsage(EMPTY_STREAM_USAGE, priced).costUsd).toBe(0.5);
    expect(addStreamUsage(priced, unpriced)).not.toHaveProperty('costUsd');
    expect(addStreamUsage(unpriced, priced)).not.toHaveProperty('costUsd');
  });
});

describe('pickStreamUsage', () => {
  it('copies only usage fields from a done event', () => {
    const done: StreamEvent & { type: 'done' } = {
      type: 'done',
      inputTokens: 1,
      outputTokens: 2,
      thinkingTokens: 3,
      costUsd: 0.25,
      filesTouched: { 'a.md': 1 },
      model: 'opus',
    };
    expect(pickStreamUsage(done)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      thinkingTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    });
  });
});
