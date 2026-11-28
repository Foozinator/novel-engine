import type { IPipelineService, IRunLogService } from '@domain/interfaces';
import type {
  AgentName,
  PhaseStatus,
  PipelinePhase,
  PipelinePhaseId,
  RunEventBody,
  RunLog,
  RunLogIssue,
} from '@domain/types';
import { reopenEvents } from './runLog';

export type ShadowMismatch = {
  phase: PipelinePhaseId;
  legacy: PhaseStatus;
  /** What the run log shows; 'missing' when it has no run for the phase. */
  log: PhaseStatus | 'missing';
};

/** What shadow mode tells the composition root. Reports repeat only when they change. */
export type ShadowReport =
  | { kind: 'migrated' | 'remigrated'; bookSlug: string; notice: string | null }
  | { kind: 'mismatch'; bookSlug: string; mismatches: ShadowMismatch[] }
  | { kind: 'issues'; bookSlug: string; issues: RunLogIssue[] }
  | { kind: 'error'; bookSlug: string; during: string; message: string };

/**
 * ShadowPipelineService — the run log in shadow mode (#87, PR 1).
 *
 * Wraps the legacy PipelineService, which still decides everything: every
 * call returns exactly what it returns, and its errors propagate. Alongside:
 *
 * - **Migration on open.** A book becomes tracked when it is opened
 *   (`openBook`). The next `detectPhases` migrates it: the run log is built
 *   from the legacy view and the files, and nothing else is written.
 * - **Mirroring.** Each legacy action is recorded in the log: Advance and
 *   Done as `done` (the next run starts with today's outputs as baseline),
 *   Revert as `reopened` for the phase and every later finished one. The
 *   log then notes the new hash of pipeline-state.json.
 * - **Check.** Each `detectPhases` recomputes the legacy view from the log
 *   and the files and reports any difference. When pipeline-state.json no
 *   longer matches the log (an older build was used, or a mirror failed),
 *   the book is migrated again as a new epoch.
 *
 * Shadow work never fails a call: its errors are reported, not thrown.
 */
export class ShadowPipelineService implements IPipelineService {
  private open = new Set<string>();
  /** Last report signature per book and kind, so repeats stay quiet. */
  private lastReported = new Map<string, string>();

  constructor(
    private legacy: IPipelineService,
    private runLog: IRunLogService,
    private report: (report: ShadowReport) => void,
  ) {}

  /** The author opened this book: its next detection migrates it. */
  openBook(bookSlug: string): void {
    this.open.add(bookSlug);
  }

  async detectPhases(bookSlug: string): Promise<PipelinePhase[]> {
    const phases = await this.legacy.detectPhases(bookSlug);
    await this.shadow(bookSlug, 'detect', () => this.check(bookSlug, phases));
    return phases;
  }

  getActivePhase(bookSlug: string): Promise<PipelinePhase | null> {
    return this.legacy.getActivePhase(bookSlug);
  }

  getAgentForPhase(phaseId: PipelinePhaseId): AgentName | null {
    return this.legacy.getAgentForPhase(phaseId);
  }

  confirmPhaseAdvancement(bookSlug: string, phaseId: PipelinePhaseId): Promise<void> {
    return this.mirrored(
      bookSlug,
      'confirm',
      () => this.legacy.confirmPhaseAdvancement(bookSlug, phaseId),
      (log) => this.done(bookSlug, log, phaseId),
    );
  }

  markPhaseComplete(bookSlug: string, phaseId: PipelinePhaseId): Promise<void> {
    return this.mirrored(
      bookSlug,
      'mark done',
      () => this.legacy.markPhaseComplete(bookSlug, phaseId),
      (log) => this.done(bookSlug, log, phaseId),
    );
  }

  completeRevision(bookSlug: string): Promise<void> {
    return this.mirrored(
      bookSlug,
      'complete revision',
      () => this.legacy.completeRevision(bookSlug),
      (log) => this.done(bookSlug, log, 'revision'),
    );
  }

  revertPhase(bookSlug: string, phaseId: PipelinePhaseId): Promise<void> {
    return this.mirrored(
      bookSlug,
      'revert',
      () => this.legacy.revertPhase(bookSlug, phaseId),
      async (log) => {
        const from = log.runs.findIndex((r) => r.legacyPhase === phaseId);
        if (from === -1) return [];
        return reopenEvents(log, log.runs.slice(from).map((r) => r.id));
      },
    );
  }

  // ── Shadow work ─────────────────────────────────────────────────────────

  private async check(bookSlug: string, phases: PipelinePhase[]): Promise<void> {
    let log = await this.runLog.load(bookSlug);
    if (!log.migrated && !this.open.has(bookSlug)) return;

    const sha = await this.runLog.legacyStateHash(bookSlug);
    if (!log.migrated || log.legacySha !== sha) {
      const result = await this.runLog.migrate(bookSlug, phases);
      log = result.log;
      if (result.outcome !== 'up-to-date') {
        this.report({ kind: result.outcome, bookSlug, notice: result.notice });
      }
    }

    if (log.issues.length > 0 && this.changed(bookSlug, 'issues', JSON.stringify(log.issues))) {
      this.report({ kind: 'issues', bookSlug, issues: log.issues });
    }

    const projected = await this.runLog.projectLegacy(bookSlug, log);
    const mismatches: ShadowMismatch[] = phases
      .filter((p) => projected[p.id] !== p.status)
      .map((p) => ({ phase: p.id, legacy: p.status, log: projected[p.id] ?? 'missing' }));
    if (this.changed(bookSlug, 'mismatch', JSON.stringify(mismatches)) && mismatches.length > 0) {
      this.report({ kind: 'mismatch', bookSlug, mismatches });
    }
  }

  /**
   * Run a legacy action, then record it in the log. Recorded only when the
   * log was in step with pipeline-state.json before the action; otherwise
   * the next detection migrates again.
   */
  private async mirrored(
    bookSlug: string,
    during: string,
    action: () => Promise<void>,
    plan: (log: RunLog) => Promise<RunEventBody[]>,
  ): Promise<void> {
    let before: string | null | undefined;
    try {
      before = await this.runLog.legacyStateHash(bookSlug);
    } catch {
      before = undefined;
    }

    await action();

    await this.shadow(bookSlug, during, async () => {
      const after = await this.runLog.legacyStateHash(bookSlug);
      await this.runLog.update(bookSlug, async (log) => {
        if (!log.migrated || before === undefined || log.legacySha !== before) return [];
        const bodies = await plan(log);
        if (after !== before) bodies.push({ e: 'legacy-synced', sha256: after });
        return bodies;
      });
    });
  }

  private async done(bookSlug: string, log: RunLog, phaseId: PipelinePhaseId): Promise<RunEventBody[]> {
    const run = log.runs.find((r) => r.legacyPhase === phaseId);
    return run ? this.runLog.doneEvents(bookSlug, log, run.id) : [];
  }

  private async shadow(bookSlug: string, during: string, work: () => Promise<void>): Promise<void> {
    const kind = `error:${during}`;
    try {
      await work();
      this.lastReported.delete(`${bookSlug}\0${kind}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.changed(bookSlug, kind, message)) {
        this.report({ kind: 'error', bookSlug, during, message });
      }
    }
  }

  private changed(bookSlug: string, kind: string, signature: string): boolean {
    const key = `${bookSlug}\0${kind}`;
    if (this.lastReported.get(key) === signature) return false;
    this.lastReported.set(key, signature);
    return true;
  }
}
