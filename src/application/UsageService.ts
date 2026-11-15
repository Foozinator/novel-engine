import type { IDatabaseService, IUsageService } from '@domain/interfaces';
import type { NewUsageRecord, UsageRecord, UsageSummary } from '@domain/types';

/**
 * UsageService — Centralizes token tracking.
 *
 * Wraps IDatabaseService usage methods. Records token counts (including
 * prompt-cache reads/writes) and the provider-reported cost when there is
 * one. Cost estimation for unpriced usage lives in StatisticsService.
 */
export class UsageService implements IUsageService {
  constructor(private db: IDatabaseService) {}

  /**
   * Record a usage event. Cache counts default to 0, cost to null (not reported).
   */
  recordUsage(params: NewUsageRecord): void {
    this.db.recordUsage(params);
  }

  /**
   * Get aggregated usage summary, optionally filtered by book.
   */
  getSummary(bookSlug?: string): UsageSummary {
    return this.db.getUsageSummary(bookSlug);
  }

  /**
   * Get all usage records for a specific conversation.
   */
  getByConversation(conversationId: string): UsageRecord[] {
    return this.db.getUsageByConversation(conversationId);
  }
}
