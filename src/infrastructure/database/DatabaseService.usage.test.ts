import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from './DatabaseService';
import { makeConversation, makeDb, makeUsage } from '../../test/db';

let db: DatabaseService;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = makeDb();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('recordUsage / getUsageByConversation', () => {
  it('round-trips usage records in insertion order', () => {
    const conv = makeConversation(db);
    makeUsage(db, conv.id, { inputTokens: 1, outputTokens: 2, thinkingTokens: 3, model: 'model-a' });
    makeUsage(db, conv.id, { inputTokens: 10, outputTokens: 20, thinkingTokens: 30, model: 'model-b' });

    const records = db.getUsageByConversation(conv.id);
    expect(records.length).toBe(2);
    expect(records[0]).toMatchObject({
      conversationId: conv.id,
      inputTokens: 1,
      outputTokens: 2,
      thinkingTokens: 3,
      model: 'model-a',
    });
    expect(records[1].model).toBe('model-b');
  });

  it('stores cache tokens and reported cost, defaulting to 0 and null', () => {
    const conv = makeConversation(db);
    makeUsage(db, conv.id, { cacheReadTokens: 500, cacheWriteTokens: 40, costUsd: 0.12 });
    makeUsage(db, conv.id);

    const [priced, unpriced] = db.getUsageByConversation(conv.id);
    expect(priced).toMatchObject({ cacheReadTokens: 500, cacheWriteTokens: 40, costUsd: 0.12 });
    expect(unpriced).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null });
  });

  it('returns an empty array for a conversation with no usage', () => {
    expect(db.getUsageByConversation('none')).toEqual([]);
  });
});

describe('getUsageSummary', () => {
  it('sums tokens across all records and counts distinct conversations', () => {
    const a = makeConversation(db);
    const b = makeConversation(db);
    makeUsage(db, a.id, { inputTokens: 100, outputTokens: 10, thinkingTokens: 1 });
    makeUsage(db, a.id, { inputTokens: 200, outputTokens: 20, thinkingTokens: 2 });
    makeUsage(db, b.id, { inputTokens: 300, outputTokens: 30, thinkingTokens: 3 });

    expect(db.getUsageSummary()).toEqual({
      totalInputTokens: 600,
      totalOutputTokens: 60,
      totalThinkingTokens: 6,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      conversationCount: 2,
    });
  });

  it('filters by book slug via the conversation join', () => {
    const mine = makeConversation(db, { bookSlug: 'mine' });
    const other = makeConversation(db, { bookSlug: 'other' });
    makeUsage(db, mine.id, { inputTokens: 5, outputTokens: 5, thinkingTokens: 5 });
    makeUsage(db, other.id, { inputTokens: 999, outputTokens: 999, thinkingTokens: 999 });

    expect(db.getUsageSummary('mine')).toEqual({
      totalInputTokens: 5,
      totalOutputTokens: 5,
      totalThinkingTokens: 5,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      conversationCount: 1,
    });
  });

  it('returns zeros on an empty database', () => {
    expect(db.getUsageSummary()).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      conversationCount: 0,
    });
  });
});

describe('getUsageOverTime', () => {
  it('buckets by day and sums within the bucket', () => {
    const conv = makeConversation(db);
    makeUsage(db, conv.id, { inputTokens: 1, outputTokens: 2, thinkingTokens: 3 });
    makeUsage(db, conv.id, { inputTokens: 4, outputTokens: 5, thinkingTokens: 6 });

    const points = db.getUsageOverTime();
    expect(points.length).toBe(1); // both records land in today's bucket
    expect(points[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(points[0]).toMatchObject({ inputTokens: 5, outputTokens: 7, thinkingTokens: 9 });
  });

  it('filters by book and returns [] when empty', () => {
    const other = makeConversation(db, { bookSlug: 'other' });
    makeUsage(db, other.id);

    expect(db.getUsageOverTime('mine')).toEqual([]);
    expect(db.getUsageOverTime('other').length).toBe(1);
  });
});

describe('getUsageByAgent', () => {
  it('groups by agent, ordered by total tokens descending', () => {
    const spark = makeConversation(db, { agentName: 'Spark' });
    const verity1 = makeConversation(db, { agentName: 'Verity' });
    const verity2 = makeConversation(db, { agentName: 'Verity' });
    makeUsage(db, spark.id, { inputTokens: 10, outputTokens: 0, thinkingTokens: 0 });
    makeUsage(db, verity1.id, { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 });
    makeUsage(db, verity2.id, { inputTokens: 200, outputTokens: 0, thinkingTokens: 25 });

    const rows = db.getUsageByAgent();
    expect(rows.map((r) => r.agentName)).toEqual(['Verity', 'Spark']);
    expect(rows[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 50,
      thinkingTokens: 25,
      conversationCount: 2,
    });
  });
});

describe('getUsageByPhase', () => {
  it('buckets null pipeline phases as "adhoc" and filters by book', () => {
    const pitch = makeConversation(db, { pipelinePhase: 'pitch' });
    const adhoc = makeConversation(db, { pipelinePhase: null });
    makeUsage(db, pitch.id, { inputTokens: 10, outputTokens: 0, thinkingTokens: 0 });
    makeUsage(db, adhoc.id, { inputTokens: 90, outputTokens: 0, thinkingTokens: 0 });

    const rows = db.getUsageByPhase('test-book');
    expect(rows.map((r) => r.phase)).toEqual(['adhoc', 'pitch']); // ordered by total DESC
    expect(rows[0].inputTokens).toBe(90);
    expect(db.getUsageByPhase('unknown-book')).toEqual([]);
  });
});

describe('getUsageCostBasis', () => {
  it('groups by agent, phase and model, and filters by book', () => {
    const spark = makeConversation(db, { agentName: 'Spark', pipelinePhase: 'pitch' });
    const verity = makeConversation(db, { agentName: 'Verity', pipelinePhase: null });
    makeUsage(db, spark.id, { inputTokens: 10, outputTokens: 1, thinkingTokens: 0, model: 'opus' });
    makeUsage(db, spark.id, { inputTokens: 5, outputTokens: 1, thinkingTokens: 2, model: 'opus' });
    makeUsage(db, spark.id, { inputTokens: 7, outputTokens: 0, thinkingTokens: 0, model: 'claude-opus-5-5' });
    makeUsage(db, verity.id, { inputTokens: 3, outputTokens: 0, thinkingTokens: 0, model: 'sonnet' });

    const rows = db.getUsageCostBasis('test-book');
    const key = (r: { agentName: string; phase: string; model: string }) => `${r.agentName}|${r.phase}|${r.model}`;
    expect(Object.fromEntries(rows.map((r) => [key(r), [r.unreportedInputTokens, r.unreportedOutputTokens, r.unreportedThinkingTokens]]))).toEqual({
      'Spark|pitch|opus': [15, 2, 2],
      'Spark|pitch|claude-opus-5-5': [7, 0, 0],
      'Verity|adhoc|sonnet': [3, 0, 0],
    });
    expect(db.getUsageCostBasis()).toHaveLength(3);
    expect(db.getUsageCostBasis('unknown-book')).toEqual([]);
  });
});

describe('getUsageCostBasis — reported cost', () => {
  it('sums reported costs and counts tokens only from unpriced rows', () => {
    const conv = makeConversation(db, { agentName: 'Verity', pipelinePhase: 'first-draft' });
    makeUsage(db, conv.id, { inputTokens: 10, outputTokens: 5, thinkingTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 90, costUsd: 0.5, model: 'opus' });
    makeUsage(db, conv.id, { inputTokens: 20, outputTokens: 6, thinkingTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 10, costUsd: 0.25, model: 'opus' });
    makeUsage(db, conv.id, { inputTokens: 3, outputTokens: 2, thinkingTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 4, model: 'opus' });

    expect(db.getUsageCostBasis('test-book')).toEqual([
      {
        agentName: 'Verity',
        phase: 'first-draft',
        model: 'opus',
        reportedCostUsd: 0.75,
        unreportedInputTokens: 3,
        unreportedOutputTokens: 2,
        unreportedThinkingTokens: 1,
        unreportedCacheReadTokens: 7,
        unreportedCacheWriteTokens: 4,
      },
    ]);
  });
});

describe('getUsageSummary — cache tokens', () => {
  it('totals cache reads and writes', () => {
    const conv = makeConversation(db);
    makeUsage(db, conv.id, { cacheReadTokens: 100, cacheWriteTokens: 10 });
    makeUsage(db, conv.id, { cacheReadTokens: 50, cacheWriteTokens: 5 });
    expect(db.getUsageSummary()).toMatchObject({ totalCacheReadTokens: 150, totalCacheWriteTokens: 15 });
  });
});

describe('getLastConversation', () => {
  it('returns the agent, title, and timestamp for the book, or null', () => {
    expect(db.getLastConversation('empty-book')).toBeNull();

    makeConversation(db, { bookSlug: 'my-book', agentName: 'Lumen', title: 'Assessment' });
    const last = db.getLastConversation('my-book');
    expect(last).toMatchObject({ agentName: 'Lumen', title: 'Assessment' });
    expect(last?.updatedAt.length).toBeGreaterThan(0);
  });
});
