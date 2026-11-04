import type {
  IStatisticsService,
  IDatabaseService,
  IFileSystemService,
} from '@domain/interfaces';
import type {
  AgentUsageBreakdown,
  BookStatistics,
  PhaseUsageBreakdown,
  UsageCostBasisRow,
} from '@domain/types';
import { getModelPricing } from '@domain/constants';

export class StatisticsService implements IStatisticsService {
  constructor(
    private db: IDatabaseService,
    private fs: IFileSystemService,
  ) {}

  async getStatistics(bookSlug?: string): Promise<BookStatistics> {
    const usageOverTime = this.db.getUsageOverTime(bookSlug);
    const perAgentRaw = this.db.getUsageByAgent(bookSlug);
    const perPhaseRaw = this.db.getUsageByPhase(bookSlug);
    const wordCountHistory = this.db.getWordCountHistory(bookSlug);
    const usageSummary = this.db.getUsageSummary(bookSlug);

    let wordsPerChapter: { slug: string; wordCount: number }[] = [];
    if (bookSlug) {
      try {
        wordsPerChapter = await this.fs.countWordsPerChapter(bookSlug);
      } catch {
        // Book may not exist or have no chapters
      }
    }

    // Price each (agent, phase, model) group at that model's rate, then roll up.
    const costBasis = this.db.getUsageCostBasis(bookSlug);
    const costByAgent = new Map<string, number>();
    const costByPhase = new Map<string, number>();
    let totalCost = 0;
    for (const row of costBasis) {
      const cost = this.rawCost(row);
      costByAgent.set(row.agentName, (costByAgent.get(row.agentName) ?? 0) + cost);
      costByPhase.set(row.phase, (costByPhase.get(row.phase) ?? 0) + cost);
      totalCost += cost;
    }

    const perAgent: AgentUsageBreakdown[] = perAgentRaw.map((r) => ({
      ...r,
      estimatedCost: roundCents(costByAgent.get(r.agentName) ?? 0),
    }));

    const perPhase: PhaseUsageBreakdown[] = perPhaseRaw.map((r) => ({
      ...r,
      estimatedCost: roundCents(costByPhase.get(r.phase) ?? 0),
    }));

    const totalCostEstimate = roundCents(totalCost);

    return {
      usageOverTime,
      perAgent,
      perPhase,
      wordCountHistory,
      totalCostEstimate,
      wordsPerChapter,
      totalTokens: {
        input: usageSummary.totalInputTokens,
        output: usageSummary.totalOutputTokens,
        thinking: usageSummary.totalThinkingTokens,
      },
      conversationCount: usageSummary.conversationCount,
    };
  }

  async recordWordCountSnapshot(bookSlug: string): Promise<void> {
    try {
      const chapters = await this.fs.countWordsPerChapter(bookSlug);
      const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
      this.db.recordWordCountSnapshot(bookSlug, totalWords, chapters.length);
    } catch {
      // Silently skip if book doesn't exist or has no chapters
    }
  }

  /**
   * Unrounded cost of one usage group, priced at the model that ran it
   * (see getModelPricing for how unlisted models are priced). Best-effort:
   * cache reads/writes are not in the recorded token counts.
   */
  private rawCost(row: UsageCostBasisRow): number {
    const pricing = getModelPricing(row.model);
    const inputCost = (row.inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = ((row.outputTokens + row.thinkingTokens) / 1_000_000) * pricing.outputPer1M;
    return inputCost + outputCost;
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
