// THROWAWAY — spike #56 (iteration model). Proof code only; not for merge.
import type { AgentName, PhaseStatus, PipelinePhaseId } from '@domain/types';
import type { PassKind, PhaseType } from './model';

/** Per-book run log. JSON Lines, one event per line, only ever appended to. */
export const RUN_LOG_PATH = 'pipeline-log.jsonl';

export type RunState = 'planned' | 'proposed' | 'active' | 'done' | 'skipped' | 'declined';
export type Origin = 'template' | 'author' | 'agent' | 'import' | 'migration';

/** A run's output, addressed by content. Resolved to the live file or one of its `-vN` archives. */
export type OutputRef = { path: string; sha256: string; words: number };

export type ChapterRef = { slug: string; sha256: string; words: number };

type EventBody =
  | {
      e: 'migrated';
      /** The legacy state the log was built from, so a changed file can be detected later. */
      from: { file: 'pipeline-state.json'; sha256: string | null; confirmedPhases: string[] | null; readable: boolean };
      /** What the legacy pipeline showed at migration time. */
      legacy: Partial<Record<PipelinePhaseId, PhaseStatus>>;
      /** Number of events the migration wrote after this one, in the same batch. */
      batch: number;
    }
  | {
      e: 'planned';
      run: string;
      phase: PhaseType;
      pass: string;
      passKind: PassKind;
      /** Insert after this run in the plan; null = at the start. */
      after: string | null;
      origin: Origin;
      label?: string;
      legacyPhase?: PipelinePhaseId;
      /** Set for origin `agent`: the run is `proposed` until the author approves it. */
      proposedBy?: AgentName;
      reason?: string;
    }
  | { e: 'approved'; run: string }
  | { e: 'declined'; run: string }
  /** Baseline: output hashes when the run started (null per path = absent). Null baseline = unknown (migrated pending). */
  | { e: 'started'; run: string; baseline: Record<string, string | null> | null; draft?: number }
  /** A pass was inserted before this started run; it goes back to planned. */
  | { e: 'deferred'; run: string }
  | { e: 'done'; run: string; outputs: OutputRef[]; migrated?: boolean }
  | { e: 'skipped'; run: string; reason: string }
  /** Undo the last Done (replaces Revert). Later runs that never started are untouched. */
  | { e: 'reopened'; run: string }
  | { e: 'archived'; path: string; to: string; sha256: string }
  | { e: 'snapshot'; draft: number; dir: string; reason: string; chapters: ChapterRef[] };

export type RunEvent = { v: 1; seq: number; at: string } & EventBody;
export type NewEvent = EventBody;

export type Run = {
  id: string;
  phase: PhaseType;
  pass: string;
  passKind: PassKind;
  origin: Origin;
  label?: string;
  legacyPhase?: PipelinePhaseId;
  proposedBy?: AgentName;
  state: RunState;
  baseline?: Record<string, string | null> | null;
  outputs: OutputRef[];
  startedAt?: string;
  doneAt?: string;
  skipReason?: string;
};

export type Folded = {
  /** Runs in plan order: history, then the current run, then what is planned. */
  runs: Run[];
  migrated: Extract<RunEvent, { e: 'migrated' }> | null;
  /** Events after the latest `migrated` event that the migration did not write. */
  postMigrationEvents: number;
  archived: Extract<RunEvent, { e: 'archived' }>[];
  drafts: Extract<RunEvent, { e: 'snapshot' }>[];
  lastSeq: number;
  /** Lines that did not parse (a torn last write). Reported, never fatal. */
  badLines: number;
};

export function parseLog(raw: string): { events: RunEvent[]; badLines: number } {
  const events: RunEvent[] = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RunEvent;
      if (parsed && parsed.v === 1 && typeof parsed.e === 'string') events.push(parsed);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

export function serialize(events: RunEvent[]): string {
  return events.map((ev) => JSON.stringify(ev)).join('\n') + (events.length ? '\n' : '');
}

/** Stamp new events with sequence numbers and a time. */
export function stamp(bodies: NewEvent[], lastSeq: number, at = new Date().toISOString()): RunEvent[] {
  return bodies.map((body, i) => ({ v: 1, seq: lastSeq + i + 1, at, ...body }) as RunEvent);
}

/**
 * Fold the event stream into the current plan. A `migrated` event starts a new
 * epoch: runs from before it stay in the file as history but leave the plan.
 */
export function fold(events: RunEvent[], badLines = 0): Folded {
  let runs: Run[] = [];
  let migrated: Folded['migrated'] = null;
  let postMigrationEvents = 0;
  const archived: Folded['archived'] = [];
  const drafts: Folded['drafts'] = [];
  let lastSeq = 0;

  const byId = (id: string): Run => {
    const run = runs.find((r) => r.id === id);
    if (!run) throw new Error(`Run log refers to unknown run "${id}"`);
    return run;
  };

  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq);
    if (ev.e === 'migrated') {
      runs = [];
      migrated = ev;
      postMigrationEvents = 0;
      continue;
    }
    if (migrated && ev.seq > migrated.seq + migrated.batch) postMigrationEvents++;

    switch (ev.e) {
      case 'planned': {
        const run: Run = {
          id: ev.run,
          phase: ev.phase,
          pass: ev.pass,
          passKind: ev.passKind,
          origin: ev.origin,
          label: ev.label,
          legacyPhase: ev.legacyPhase,
          proposedBy: ev.proposedBy,
          state: ev.origin === 'agent' ? 'proposed' : 'planned',
          outputs: [],
        };
        const at = ev.after === null ? 0 : runs.findIndex((r) => r.id === ev.after) + 1;
        if (ev.after !== null && at === 0) throw new Error(`Run log inserts after unknown run "${ev.after}"`);
        runs.splice(at, 0, run);
        break;
      }
      case 'approved':
        byId(ev.run).state = 'planned';
        break;
      case 'declined':
        byId(ev.run).state = 'declined';
        break;
      case 'started': {
        const run = byId(ev.run);
        run.state = 'active';
        run.baseline = ev.baseline;
        run.startedAt = ev.at;
        break;
      }
      case 'deferred': {
        const run = byId(ev.run);
        run.state = 'planned';
        run.baseline = undefined;
        break;
      }
      case 'done': {
        const run = byId(ev.run);
        run.state = 'done';
        run.outputs = ev.outputs;
        run.doneAt = ev.at;
        break;
      }
      case 'skipped': {
        const run = byId(ev.run);
        run.state = 'skipped';
        run.skipReason = ev.reason;
        break;
      }
      case 'reopened': {
        const run = byId(ev.run);
        run.state = 'active';
        run.doneAt = undefined;
        break;
      }
      case 'archived':
        archived.push(ev);
        break;
      case 'snapshot':
        drafts.push(ev);
        break;
    }
  }
  return { runs, migrated, postMigrationEvents, archived, drafts, lastSeq, badLines };
}

/** The run the author is working on: the first planned or active run in plan order. */
export function currentRun(folded: Folded): Run | null {
  return folded.runs.find((r) => r.state === 'planned' || r.state === 'active') ?? null;
}

/** Next free run ID (`r1`, `r2`, …). IDs are never reused, even across epochs. */
export function nextRunIds(events: RunEvent[], count: number): string[] {
  let max = 0;
  for (const ev of events) {
    if (ev.e === 'planned') max = Math.max(max, Number(ev.run.slice(1)) || 0);
  }
  return Array.from({ length: count }, (_, i) => `r${max + i + 1}`);
}

/** Next free pass ID (`p1`, `p2`, …). */
export function nextPassId(events: RunEvent[]): string {
  let max = 0;
  for (const ev of events) {
    if (ev.e === 'planned') max = Math.max(max, Number(ev.pass.slice(1)) || 0);
  }
  return `p${max + 1}`;
}

/** Ordinal of a run among runs of the same type in plan order ("Read 3"). */
export function ordinalOf(folded: Folded, runId: string): number {
  const run = folded.runs.find((r) => r.id === runId);
  if (!run) return 0;
  return folded.runs.filter((r) => r.phase === run.phase && r.state !== 'declined').findIndex((r) => r.id === runId) + 1;
}
