import type { StreamUsage } from '@domain/types';

/** Usage of a call that has not used anything yet. Its cost is a known zero. */
export const EMPTY_STREAM_USAGE: StreamUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

/**
 * Sum two usages. Token counts add, with missing cache counts read as 0. The
 * cost stays known only while both sides report one: once any part of a call
 * is unpriced, the whole call is left to the price-table estimate.
 */
export function addStreamUsage(a: StreamUsage, b: StreamUsage): StreamUsage {
  const sum: StreamUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
  if (a.costUsd !== undefined && b.costUsd !== undefined) {
    sum.costUsd = a.costUsd + b.costUsd;
  }
  return sum;
}

/** Copy only the usage fields of an event (e.g. a `done` event) for recording. */
export function pickStreamUsage(usage: StreamUsage): StreamUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  };
}
