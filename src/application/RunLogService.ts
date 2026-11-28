import type { IFileSystemService, IRunLogService } from '@domain/interfaces';
import type {
  PhaseStatus,
  PhaseType,
  PipelinePhase,
  PipelinePhaseId,
  Run,
  RunBaseline,
  RunEventBody,
  RunLog,
  RunLogMigration,
  RunOutput,
} from '@domain/types';
import {
  LEGACY_PHASE_SLOTS,
  PHASE_TYPES,
  PIPELINE_STATE_FILE,
  RUN_LOG_FILE,
  phaseTypeOutputs,
} from '@domain/constants';
import { archivePath, archiveVersions } from './archives';
import {
  countWords,
  currentRun,
  parseRunLog,
  passId,
  projectStatuses,
  runId,
  sha256Text,
  stampEvents,
} from './runLog';

type LegacyStatuses = Partial<Record<PipelinePhaseId, PhaseStatus>>;

/**
 * RunLogService — reads and appends a book's run log (#87).
 *
 * Writes go through `update`, one book at a time: read, fold, plan, check
 * that the new events fold cleanly, then append. A torn last line is left
 * in place (reads skip it) and the next append starts on a new line.
 *
 * The migration writes the log and nothing else, so an older build still
 * opens the book where it was. Deleting the log undoes it; the next open
 * migrates again.
 */
export class RunLogService implements IRunLogService {
  /** Tail of each book's write queue. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private fs: IFileSystemService,
    private clock: () => string = () => new Date().toISOString(),
  ) {}

  async load(bookSlug: string): Promise<RunLog> {
    return parseRunLog((await this.read(bookSlug, RUN_LOG_FILE)) ?? '', bookSlug);
  }

  update(bookSlug: string, plan: (log: RunLog) => Promise<RunEventBody[]>): Promise<RunLog> {
    return this.exclusive(bookSlug, async () => {
      const raw = (await this.read(bookSlug, RUN_LOG_FILE)) ?? '';
      const log = parseRunLog(raw, bookSlug);
      const bodies = await plan(log);
      if (bodies.length === 0) return log;

      const lead = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
      const lines = stampEvents(bodies, log.lastSeq, this.clock()).map((ev) => JSON.stringify(ev));
      const text = `${lead}${lines.join('\n')}\n`;

      const next = parseRunLog(raw + text, bookSlug);
      const firstNewLine = raw.split('\n').length + (lead ? 1 : 0);
      const refused = next.issues.filter((issue) => issue.line >= firstNewLine);
      if (refused.length > 0) {
        throw new Error(
          `Run log of "${bookSlug}" refused new events: ${refused.map((r) => r.reason).join('; ')}`,
        );
      }

      await this.fs.appendFile(bookSlug, RUN_LOG_FILE, text);
      return next;
    });
  }

  async migrate(bookSlug: string, legacy: PipelinePhase[]): Promise<RunLogMigration> {
    let outcome: RunLogMigration['outcome'] = 'up-to-date';
    let notice: string | null = null;

    const log = await this.update(bookSlug, async (current) => {
      const raw = await this.read(bookSlug, PIPELINE_STATE_FILE);
      const sha = raw === null ? null : sha256Text(raw);
      if (current.migrated && current.legacySha === sha) return [];

      let confirmedPhases: string[] | null = null;
      let readable = true;
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { confirmedPhases?: unknown } | null;
          confirmedPhases = Array.isArray(parsed?.confirmedPhases)
            ? parsed.confirmedPhases.filter((p): p is string => typeof p === 'string')
            : [];
        } catch {
          readable = false;
          notice = `${PIPELINE_STATE_FILE} could not be read. The pipeline position was rebuilt from the book's files; check it.`;
        }
      }

      outcome = current.migrated ? 'remigrated' : 'migrated';
      const statuses: LegacyStatuses = Object.fromEntries(legacy.map((p) => [p.id, p.status]));
      const bodies = await this.migrationEvents(bookSlug, current, statuses);
      return [
        {
          e: 'migrated',
          from: { file: PIPELINE_STATE_FILE, sha256: sha, confirmedPhases, readable },
          legacy: statuses,
          batch: bodies.length,
        },
        ...bodies,
      ];
    });

    return { outcome, log, notice };
  }

  async legacyStateHash(bookSlug: string): Promise<string | null> {
    const raw = await this.read(bookSlug, PIPELINE_STATE_FILE);
    return raw === null ? null : sha256Text(raw);
  }

  async isReady(bookSlug: string, run: Run): Promise<boolean> {
    if (run.state !== 'active') return false;
    const def = PHASE_TYPES[run.type];
    if (def.gate === 'action') return run.baseline === null;

    const paths = phaseTypeOutputs(run.type, bookSlug);
    if (paths.length === 0) return false;
    // No recorded baseline: whatever is there counts as this run's work.
    let changed = run.baseline === null || run.baseline === undefined;
    for (const path of paths) {
      const content = await this.read(bookSlug, path);
      if (content === null || countWords(content) < def.minWords) return false;
      if (run.baseline && run.baseline[path] !== sha256Text(content)) changed = true;
    }
    return changed;
  }

  async projectLegacy(bookSlug: string, log: RunLog): Promise<LegacyStatuses> {
    const current = currentRun(log);
    return projectStatuses(log, current ? await this.isReady(bookSlug, current) : false);
  }

  async doneEvents(bookSlug: string, log: RunLog, id: string): Promise<RunEventBody[]> {
    const run = log.runs.find((r) => r.id === id);
    if (!run || (run.state !== 'planned' && run.state !== 'active')) return [];

    const bodies: RunEventBody[] = [
      { e: 'done', run: id, outputs: await this.outputRefs(bookSlug, run.type) },
    ];
    // The next run starts now: today's outputs are its baseline.
    const next = log.runs.find((r) => r.id !== id && (r.state === 'planned' || r.state === 'active'));
    if (next?.state === 'planned') {
      bodies.push({ e: 'started', run: next.id, baseline: await this.baselineOf(bookSlug, next.type) });
    }
    return bodies;
  }

  // ── Migration ───────────────────────────────────────────────────────────

  /**
   * One planned run per legacy phase, then the state each one is in:
   * complete → done (outputs located by content), pending-completion →
   * started with an unknown baseline (its files count as new), active →
   * started with today's hashes as the baseline, locked → planned.
   * Run and pass numbers continue after any earlier epoch.
   */
  private async migrationEvents(
    bookSlug: string,
    current: RunLog,
    statuses: LegacyStatuses,
  ): Promise<RunEventBody[]> {
    const id = (i: number) => runId(current.maxRun + i + 1);
    const bodies: RunEventBody[] = LEGACY_PHASE_SLOTS.map((slot, i) => ({
      e: 'planned',
      run: id(i),
      type: slot.type,
      pass: passId(current.maxPass + slot.passIndex + 1),
      passKind: slot.passKind,
      after: i === 0 ? null : id(i - 1),
      origin: 'migration',
      legacyPhase: slot.legacyPhase,
    }));

    const outputs = await this.attributeOutputs(bookSlug, statuses);
    for (const [i, slot] of LEGACY_PHASE_SLOTS.entries()) {
      const status = statuses[slot.legacyPhase] ?? 'locked';
      if (status === 'complete') {
        bodies.push({ e: 'done', run: id(i), outputs: outputs.get(i) ?? [] });
      } else if (status === 'pending-completion') {
        bodies.push({ e: 'started', run: id(i), baseline: null });
      } else if (status === 'active') {
        bodies.push({ e: 'started', run: id(i), baseline: await this.baselineOf(bookSlug, slot.type) });
      }
    }
    return bodies;
  }

  /**
   * Give each finished legacy phase the content it produced. Per output
   * path, the versions are its archives (oldest first) then the live file,
   * with repeats collapsed. Walking that path's phases from the last back,
   * each takes the newest version not yet taken. An active phase keeps a
   * live file it has rewritten since the newest archive. Versions left
   * over (abandoned attempts) stay on disk, unattributed.
   */
  private async attributeOutputs(
    bookSlug: string,
    statuses: LegacyStatuses,
  ): Promise<Map<number, RunOutput[]>> {
    const result = new Map<number, RunOutput[]>();
    const paths = new Set(LEGACY_PHASE_SLOTS.flatMap((s) => phaseTypeOutputs(s.type, bookSlug)));

    for (const path of paths) {
      const chain: { sha: string; words: number }[] = [];
      for (const version of await archiveVersions(this.fs, bookSlug, path)) {
        const content = await this.read(bookSlug, archivePath(path, version));
        if (content !== null) chain.push({ sha: sha256Text(content), words: countWords(content) });
      }
      const newestArchive = chain.length > 0 ? chain[chain.length - 1].sha : null;
      const live = await this.read(bookSlug, path);
      const liveSha = live === null ? null : sha256Text(live);
      if (live !== null && liveSha !== null) chain.push({ sha: liveSha, words: countWords(live) });
      const versions = chain.filter((c, i) => i === 0 || c.sha !== chain[i - 1].sha);

      const slots = LEGACY_PHASE_SLOTS.map((slot, i) => ({ slot, i })).filter(({ slot }) =>
        phaseTypeOutputs(slot.type, bookSlug).includes(path),
      );
      for (const { slot, i } of slots.reverse()) {
        const status = statuses[slot.legacyPhase] ?? 'locked';
        if (status === 'locked') continue;
        if (status === 'active') {
          if (liveSha !== null && newestArchive !== null && liveSha !== newestArchive) versions.pop();
          continue;
        }
        const taken = versions.pop();
        if (!taken || status !== 'complete') continue;
        result.set(i, [...(result.get(i) ?? []), { path, sha256: taken.sha, words: taken.words }]);
      }
    }
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async baselineOf(bookSlug: string, type: PhaseType): Promise<RunBaseline> {
    const baseline: RunBaseline = {};
    for (const path of phaseTypeOutputs(type, bookSlug)) {
      const content = await this.read(bookSlug, path);
      baseline[path] = content === null ? null : sha256Text(content);
    }
    return baseline;
  }

  private async outputRefs(bookSlug: string, type: PhaseType): Promise<RunOutput[]> {
    const refs: RunOutput[] = [];
    for (const path of phaseTypeOutputs(type, bookSlug)) {
      const content = await this.read(bookSlug, path);
      if (content !== null) refs.push({ path, sha256: sha256Text(content), words: countWords(content) });
    }
    return refs;
  }

  private async read(bookSlug: string, path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(bookSlug, path);
    } catch {
      return null;
    }
  }

  /** Run `task` after every earlier task for the same book has settled. */
  private exclusive<T>(bookSlug: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(bookSlug) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => undefined);
    this.queues.set(bookSlug, tail);
    void tail.then(() => {
      if (this.queues.get(bookSlug) === tail) this.queues.delete(bookSlug);
    });
    return result;
  }
}
