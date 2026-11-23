// THROWAWAY — spike #56 (iteration model). Proof code only; not for merge.
import type { IFileSystemService } from '@domain/interfaces';
import type { PhaseStatus, PipelinePhaseId } from '@domain/types';
import { PipelineService } from '../PipelineService';
import { archivePath, archiveVersions } from '../archives';
import { LEGACY_SLOTS, outputsOf } from './model';
import { RunEngine, countWords, sha256 } from './engine';
import { RUN_LOG_PATH, fold, type Folded, type NewEvent, type OutputRef } from './runLog';

const LEGACY_STATE = 'pipeline-state.json';

/**
 * A view of the filesystem that never writes. The legacy detector writes
 * pipeline-state.json when it is missing; through this view it is a pure
 * function of the files, so it can serve as the migration's oracle.
 */
export function readOnly(fs: IFileSystemService): IFileSystemService {
  const blocked = new Set(['writeFile', 'deleteFile', 'deletePath', 'renameFile', 'updateBookMeta', 'createBook']);
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (typeof key === 'string' && blocked.has(key)) return async () => undefined;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What today's pipeline shows for the book, without writing anything. */
export async function legacyStatuses(fs: IFileSystemService, slug: string): Promise<Record<PipelinePhaseId, PhaseStatus>> {
  const phases = await new PipelineService(readOnly(fs)).detectPhases(slug);
  return Object.fromEntries(phases.map((p) => [p.id, p.status])) as Record<PipelinePhaseId, PhaseStatus>;
}

async function readOrNull(fs: IFileSystemService, slug: string, path: string): Promise<string | null> {
  try {
    return await fs.readFile(slug, path);
  } catch {
    return null;
  }
}

export type MigrationResult =
  | { outcome: 'migrated' | 'remigrated' | 'up-to-date'; folded: Folded; notice: string | null }
  | { outcome: 'conflict'; folded: Folded; notice: string };

/**
 * Build the run log from today's state. Writes `pipeline-log.jsonl` and
 * nothing else: pipeline-state.json, about.json, reports and archives are
 * left byte-for-byte as they were, so an older build still opens the book
 * exactly where it was (rollback = run the older build; or delete the log
 * to re-migrate).
 *
 * - Log missing → migrate.
 * - Log present, legacy file unchanged since → nothing to do.
 * - Legacy file changed (an older build was used) and the log holds only the
 *   migration's own events → re-migrate (a new epoch, appended).
 * - Legacy file changed and the log has newer work → keep the log, warn.
 */
export async function migrateBook(fs: IFileSystemService, slug: string): Promise<MigrationResult> {
  const engine = new RunEngine(fs, slug);
  const existing = await engine.load();

  const raw = await readOrNull(fs, slug, LEGACY_STATE);
  let confirmed: string[] | null = null;
  let readable = raw !== null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { confirmedPhases?: unknown };
      confirmed = Array.isArray(parsed.confirmedPhases) ? (parsed.confirmedPhases as string[]) : [];
    } catch {
      readable = false;
    }
  }
  const fileSha = raw === null ? null : sha256(raw);

  if (existing.migrated) {
    if (existing.migrated.from.sha256 === fileSha) return { outcome: 'up-to-date', folded: existing, notice: null };
    if (existing.postMigrationEvents > 0) {
      return {
        outcome: 'conflict',
        folded: existing,
        notice: `${LEGACY_STATE} changed after the run log took over (an older build was used). The run log is kept.`,
      };
    }
  }

  const legacy = await legacyStatuses(fs, slug);
  const bodies = await buildEvents(fs, slug, legacy, existing);
  const migrated: NewEvent = {
    e: 'migrated',
    from: { file: LEGACY_STATE, sha256: fileSha, confirmedPhases: confirmed, readable: raw === null || readable },
    legacy,
    batch: bodies.length,
  };
  const folded = await engine.append([migrated, ...bodies]);
  const notice =
    raw !== null && !readable
      ? `${LEGACY_STATE} could not be read. The position was rebuilt from the book's files; check it.`
      : null;
  return { outcome: existing.migrated ? 'remigrated' : 'migrated', folded, notice };
}

/**
 * One planned run per legacy phase, then the state each one had:
 * complete → done (outputs located by content), pending-completion →
 * started with an unknown baseline (its files count as new), active →
 * started with today's hashes as baseline, locked → planned.
 */
async function buildEvents(
  fs: IFileSystemService,
  slug: string,
  legacy: Record<PipelinePhaseId, PhaseStatus>,
  existing: Folded,
): Promise<NewEvent[]> {
  // Run and pass IDs continue after any earlier epoch, never reused.
  const runBase = existing.runs.reduce((m, r) => Math.max(m, Number(r.id.slice(1))), 0);
  const passBase = existing.runs.reduce((m, r) => Math.max(m, Number(r.pass.slice(1))), 0);
  const runId = (i: number) => `r${runBase + i + 1}`;

  const bodies: NewEvent[] = LEGACY_SLOTS.map((slot, i) => ({
    e: 'planned',
    run: runId(i),
    phase: slot.type,
    pass: `p${passBase + slot.passIndex + 1}`,
    passKind: slot.passKind,
    after: i === 0 ? null : runId(i - 1),
    origin: 'migration',
    legacyPhase: slot.legacyPhase,
  }));

  const outputsByRun = await locateOutputs(fs, slug, legacy);

  for (const [i, slot] of LEGACY_SLOTS.entries()) {
    const status = legacy[slot.legacyPhase];
    if (status === 'complete') {
      bodies.push({ e: 'done', run: runId(i), outputs: outputsByRun.get(i) ?? [], migrated: true });
    } else if (status === 'pending-completion') {
      bodies.push({ e: 'started', run: runId(i), baseline: null });
    } else if (status === 'active') {
      const baseline: Record<string, string | null> = {};
      for (const p of outputsOf(slot.type, slug)) {
        const content = await readOrNull(fs, slug, p);
        baseline[p] = content === null ? null : sha256(content);
      }
      bodies.push({ e: 'started', run: runId(i), baseline });
    }
  }
  return bodies;
}

/**
 * Give each finished legacy run the content it produced. Per output path,
 * the history is its archives (oldest first) then the live file, with
 * repeats collapsed. Walking runs of that type from the last back, each
 * takes the newest content not yet taken. An active run that has not
 * written anything new takes nothing. Leftover older content (abandoned
 * attempts) stays on disk, unattributed.
 */
async function locateOutputs(
  fs: IFileSystemService,
  slug: string,
  legacy: Record<PipelinePhaseId, PhaseStatus>,
): Promise<Map<number, OutputRef[]>> {
  const result = new Map<number, OutputRef[]>();
  const paths = new Set(LEGACY_SLOTS.flatMap((s) => outputsOf(s.type, slug)));

  for (const path of paths) {
    const chain: { content: string; sha: string }[] = [];
    for (const v of await archiveVersions(fs, slug, path)) {
      const content = await readOrNull(fs, slug, archivePath(path, v));
      if (content !== null) chain.push({ content, sha: sha256(content) });
    }
    const live = await readOrNull(fs, slug, path);
    const newestArchiveSha = chain.length ? chain[chain.length - 1].sha : null;
    if (live !== null) chain.push({ content: live, sha: sha256(live) });
    const collapsed = chain.filter((c, i) => i === 0 || c.sha !== chain[i - 1].sha);

    const slots = LEGACY_SLOTS.map((s, i) => ({ ...s, i })).filter((s) => outputsOf(s.type, slug).includes(path));
    for (const slot of [...slots].reverse()) {
      const status = legacy[slot.legacyPhase];
      if (status === 'locked') continue;
      if (status === 'active') {
        const wroteNew = live !== null && newestArchiveSha !== null && sha256(live) !== newestArchiveSha;
        if (wroteNew) collapsed.pop();
        continue;
      }
      const taken = collapsed.pop();
      if (!taken || status !== 'complete') continue;
      const list = result.get(slot.i) ?? [];
      list.push({ path, sha256: taken.sha, words: countWords(taken.content) });
      result.set(slot.i, list);
    }
  }
  return result;
}

/** The legacy view, recomputed from the run log and the files (not copied from the migration). */
export async function projectLegacy(fs: IFileSystemService, slug: string, folded?: Folded): Promise<Record<PipelinePhaseId, PhaseStatus>> {
  const engine = new RunEngine(fs, slug);
  const log = folded ?? (await engine.load());
  const out = {} as Record<PipelinePhaseId, PhaseStatus>;
  for (const run of log.runs) {
    if (!run.legacyPhase) continue;
    out[run.legacyPhase] =
      run.state === 'done' || run.state === 'skipped'
        ? 'complete'
        : run.state === 'active'
          ? (await engine.isPending(run)) ? 'pending-completion' : 'active'
          : 'locked';
  }
  return out;
}

export { RUN_LOG_PATH, fold };
