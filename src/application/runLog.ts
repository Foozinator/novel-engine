import { createHash } from 'node:crypto';
import type {
  PhaseStatus,
  PhaseType,
  PipelinePhaseId,
  Run,
  RunEvent,
  RunEventBody,
  RunLog,
} from '@domain/types';
import {
  AGENT_REGISTRY,
  PASS_TEMPLATES,
  PHASE_TYPES,
  PIPELINE_PHASES,
  PIPELINE_STATE_FILE,
  phaseTypeOutputs,
} from '@domain/constants';
import { archivePath } from './archives';

/**
 * The run log's format (#87): parse, validate and fold `pipeline-log.jsonl`.
 *
 * One JSON event per line, appended only. Reading never fails: a line that
 * doesn't parse (a torn write), doesn't match its event's shape, refers to
 * a run the log doesn't know, or makes an illegal transition is dropped and
 * reported in `issues`. The rest still fold.
 */

export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf-8').digest('hex');

export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const runId = (n: number): string => `r${n}`;
export const passId = (n: number): string => `p${n}`;

export function emptyRunLog(): RunLog {
  return {
    runs: [],
    migrated: null,
    legacySha: null,
    eventsSinceMigration: 0,
    archived: [],
    drafts: [],
    lastSeq: 0,
    maxRun: 0,
    maxPass: 0,
    issues: [],
  };
}

/** The run the author is working on: the first planned or active run in plan order. */
export function currentRun(log: RunLog): Run | null {
  return log.runs.find((r) => r.state === 'planned' || r.state === 'active') ?? null;
}

/** Stamp new events with the format version, the next sequence numbers and a time. */
export function stampEvents(bodies: RunEventBody[], lastSeq: number, at: string): RunEvent[] {
  return bodies.map((body, i) => ({ ...body, v: 1, seq: lastSeq + i + 1, at }) as RunEvent);
}

/** Reopen each listed run that is done or skipped. */
export function reopenEvents(log: RunLog, runIds: string[]): RunEventBody[] {
  return runIds
    .filter((id) => {
      const run = log.runs.find((r) => r.id === id);
      return run?.state === 'done' || run?.state === 'skipped';
    })
    .map((id) => ({ e: 'reopened', run: id }));
}

// ── Shape checks ───────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const PHASE_TYPE_SET = new Set<string>(Object.keys(PHASE_TYPES));
const PASS_KIND_SET = new Set<string>(Object.keys(PASS_TEMPLATES));
const ORIGIN_SET = new Set<string>(['template', 'author', 'agent', 'import', 'migration']);
const AGENT_SET = new Set<string>(Object.keys(AGENT_REGISTRY));
const LEGACY_PHASE_SET = new Set<string>(PIPELINE_PHASES.map((p) => p.id));
const PHASE_STATUS_SET = new Set<string>(['complete', 'pending-completion', 'active', 'locked']);

const RUN_ID = /^r[1-9]\d{0,8}$/;
const PASS_ID = /^p[1-9]\d{0,8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A chapter folder name: one path segment, no dot-dot. */
const CHAPTER_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_TEXT = 2000;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_TEXT;
const isOptText = (x: unknown): boolean => x === undefined || isText(x);
const isCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isPositive = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1;
const isSha = (x: unknown): x is string => typeof x === 'string' && SHA256.test(x);
const isShaOrNull = (x: unknown): boolean => x === null || isSha(x);
const isRunId = (x: unknown): x is string => typeof x === 'string' && RUN_ID.test(x);

/** A relative path inside the book: `/`-separated, no empty, `.` or `..` segments. */
function isBookPath(x: unknown): x is string {
  if (typeof x !== 'string' || x.length === 0 || x.length > 500) return false;
  if (x.includes('\\') || x.includes('\0')) return false;
  return x.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function isOutput(x: unknown): boolean {
  return isObj(x) && isBookPath(x.path) && isSha(x.sha256) && isCount(x.words);
}

function isChapterRef(x: unknown): boolean {
  return (
    isObj(x) &&
    typeof x.slug === 'string' &&
    CHAPTER_SLUG.test(x.slug) &&
    !x.slug.includes('..') &&
    isSha(x.sha256) &&
    isCount(x.words)
  );
}

/** `to` is an archive name of `path` (`source/x.md` → `source/x-v3.md`). */
function isArchiveOf(path: string, to: unknown): boolean {
  if (typeof to !== 'string') return false;
  const match = /-v([1-9]\d{0,5})(\.[^./]*)?$/.exec(to);
  return match !== null && archivePath(path, Number(match[1])) === to;
}

/** Null when `x` has the shape of its event type; otherwise why not. */
function shapeProblem(x: Obj): string | null {
  if (x.v !== 1) return 'unknown format version';
  if (!isPositive(x.seq)) return 'bad sequence number';
  if (typeof x.at !== 'string' || x.at.length === 0 || x.at.length > 40) return 'bad time';

  switch (x.e) {
    case 'migrated': {
      const from = x.from;
      if (!isObj(from) || from.file !== PIPELINE_STATE_FILE) return 'bad legacy source';
      if (!isShaOrNull(from.sha256) || typeof from.readable !== 'boolean') return 'bad legacy source';
      if (
        from.confirmedPhases !== null &&
        !(Array.isArray(from.confirmedPhases) && from.confirmedPhases.every((p) => isText(p)))
      ) {
        return 'bad legacy source';
      }
      if (!isObj(x.legacy)) return 'bad legacy view';
      for (const [id, status] of Object.entries(x.legacy)) {
        if (!LEGACY_PHASE_SET.has(id) || typeof status !== 'string' || !PHASE_STATUS_SET.has(status)) {
          return 'bad legacy view';
        }
      }
      return isCount(x.batch) ? null : 'bad batch size';
    }
    case 'planned':
      if (!isRunId(x.run)) return 'bad run id';
      if (typeof x.type !== 'string' || !PHASE_TYPE_SET.has(x.type)) return 'unknown phase type';
      if (typeof x.pass !== 'string' || !PASS_ID.test(x.pass)) return 'bad pass id';
      if (typeof x.passKind !== 'string' || !PASS_KIND_SET.has(x.passKind)) return 'unknown pass kind';
      if (x.after !== null && !isRunId(x.after)) return 'bad position';
      if (typeof x.origin !== 'string' || !ORIGIN_SET.has(x.origin)) return 'unknown origin';
      if (!isOptText(x.label) || !isOptText(x.reason)) return 'bad text';
      if (x.legacyPhase !== undefined && !(typeof x.legacyPhase === 'string' && LEGACY_PHASE_SET.has(x.legacyPhase))) {
        return 'unknown legacy phase';
      }
      if (x.proposedBy !== undefined && !(typeof x.proposedBy === 'string' && AGENT_SET.has(x.proposedBy))) {
        return 'unknown agent';
      }
      return null;
    case 'approved':
    case 'declined':
    case 'deferred':
    case 'reopened':
      return isRunId(x.run) ? null : 'bad run id';
    case 'started': {
      if (!isRunId(x.run)) return 'bad run id';
      if (x.draft !== undefined && !isPositive(x.draft)) return 'bad draft number';
      if (x.baseline === null) return null;
      if (!isObj(x.baseline)) return 'bad baseline';
      for (const [path, sha] of Object.entries(x.baseline)) {
        if (!isBookPath(path) || !isShaOrNull(sha)) return 'bad baseline';
      }
      return null;
    }
    case 'done':
      if (!isRunId(x.run)) return 'bad run id';
      return Array.isArray(x.outputs) && x.outputs.every(isOutput) ? null : 'bad outputs';
    case 'skipped':
      if (!isRunId(x.run)) return 'bad run id';
      return isText(x.reason) ? null : 'bad text';
    case 'archived':
      if (!isBookPath(x.path) || !isSha(x.sha256)) return 'bad archive';
      return isArchiveOf(x.path, x.to) ? null : 'archive path is not a version of its file';
    case 'snapshot':
      if (!isPositive(x.draft)) return 'bad draft number';
      if (!isText(x.reason)) return 'bad text';
      return Array.isArray(x.chapters) && x.chapters.every(isChapterRef) ? null : 'bad chapters';
    case 'legacy-synced':
      return isShaOrNull(x.sha256) ? null : 'bad hash';
    default:
      return 'unknown event';
  }
}

// ── Fold ────────────────────────────────────────────────────────────────

type FoldState = RunLog & {
  /** Every run ID planned in any epoch: IDs are never reused. */
  usedRunIds: Set<string>;
  /** Accepted events after the latest `migrated` event. */
  sinceMigration: number;
};

/** Apply one validated event. Returns why it can't apply; the state is then unchanged. */
function apply(state: FoldState, ev: RunEvent, bookSlug: string): string | null {
  const find = (id: string): Run | undefined => state.runs.find((r) => r.id === id);
  const outputsOf = (type: PhaseType) => new Set(phaseTypeOutputs(type, bookSlug));

  switch (ev.e) {
    case 'migrated':
      state.runs = [];
      state.migrated = ev;
      state.legacySha = ev.from.sha256;
      state.sinceMigration = 0;
      return null;

    case 'planned': {
      if (state.usedRunIds.has(ev.run)) return `run ${ev.run} already exists`;
      let index = 0;
      if (ev.after !== null) {
        const afterIndex = state.runs.findIndex((r) => r.id === ev.after);
        if (afterIndex === -1) return `unknown run ${ev.after}`;
        index = afterIndex + 1;
      }
      state.runs.splice(index, 0, {
        id: ev.run,
        type: ev.type,
        pass: ev.pass,
        passKind: ev.passKind,
        origin: ev.origin,
        ...(ev.label !== undefined && { label: ev.label }),
        ...(ev.legacyPhase !== undefined && { legacyPhase: ev.legacyPhase }),
        ...(ev.proposedBy !== undefined && { proposedBy: ev.proposedBy }),
        ...(ev.reason !== undefined && { reason: ev.reason }),
        state: ev.origin === 'agent' ? 'proposed' : 'planned',
        outputs: [],
      });
      state.usedRunIds.add(ev.run);
      state.maxRun = Math.max(state.maxRun, Number(ev.run.slice(1)));
      state.maxPass = Math.max(state.maxPass, Number(ev.pass.slice(1)));
      return null;
    }

    case 'archived':
      state.archived.push(ev);
      return null;

    case 'snapshot': {
      const last = state.drafts[state.drafts.length - 1];
      if (last && ev.draft <= last.draft) return `draft ${ev.draft} is not after draft ${last.draft}`;
      state.drafts.push(ev);
      return null;
    }

    case 'legacy-synced':
      state.legacySha = ev.sha256;
      return null;

    default:
      break;
  }

  // Events about one run
  const run = find(ev.run);
  if (!run) return `unknown run ${ev.run}`;
  const illegal = `${ev.e} is not allowed for a ${run.state} run`;

  switch (ev.e) {
    case 'approved':
      if (run.state !== 'proposed') return illegal;
      run.state = 'planned';
      return null;
    case 'declined':
      if (run.state !== 'proposed') return illegal;
      run.state = 'declined';
      return null;
    case 'started': {
      if (run.state !== 'planned') return illegal;
      const outputs = outputsOf(run.type);
      if (ev.baseline && Object.keys(ev.baseline).some((p) => !outputs.has(p))) {
        return `baseline names a file that ${run.type} doesn't write`;
      }
      run.state = 'active';
      run.baseline = ev.baseline;
      run.startedAt = ev.at;
      return null;
    }
    case 'deferred':
      if (run.state !== 'active') return illegal;
      run.state = 'planned';
      delete run.baseline;
      delete run.startedAt;
      return null;
    case 'done': {
      if (run.state !== 'planned' && run.state !== 'active') return illegal;
      const outputs = outputsOf(run.type);
      const paths = ev.outputs.map((o) => o.path);
      if (paths.some((p) => !outputs.has(p)) || new Set(paths).size !== paths.length) {
        return `outputs don't match what ${run.type} writes`;
      }
      run.state = 'done';
      run.outputs = ev.outputs;
      run.doneAt = ev.at;
      return null;
    }
    case 'skipped':
      if (run.state !== 'planned' && run.state !== 'active' && run.state !== 'proposed') return illegal;
      run.state = 'skipped';
      run.skipReason = ev.reason;
      return null;
    case 'reopened':
      if (run.state !== 'done' && run.state !== 'skipped') return illegal;
      run.state = 'active';
      run.outputs = [];
      delete run.doneAt;
      delete run.skipReason;
      // A migrated run that was waiting for confirmation (null baseline)
      // isn't waiting any more once reopened: its action gate applies again.
      if (run.baseline === null) delete run.baseline;
      return null;
  }
}

/**
 * Fold the log's text into the current plan. A `migrated` event starts a
 * new epoch: runs from before it leave the plan but stay in the file.
 */
export function parseRunLog(raw: string, bookSlug: string): RunLog {
  const state: FoldState = { ...emptyRunLog(), usedRunIds: new Set(), sinceMigration: 0 };
  const lines = raw.split('\n');

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const lineNo = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.issues.push({ line: lineNo, reason: 'unreadable line' });
      return;
    }
    if (!isObj(parsed)) {
      state.issues.push({ line: lineNo, reason: 'not an event' });
      return;
    }
    const problem = shapeProblem(parsed);
    if (problem) {
      state.issues.push({ line: lineNo, reason: problem });
      return;
    }
    const ev = parsed as RunEvent;
    if (ev.seq <= state.lastSeq) {
      state.issues.push({ line: lineNo, reason: `sequence ${ev.seq} is not after ${state.lastSeq}` });
      return;
    }
    const refused = apply(state, ev, bookSlug);
    if (refused) {
      state.issues.push({ line: lineNo, reason: refused });
      return;
    }
    state.lastSeq = ev.seq;
    if (ev.e !== 'migrated' && state.migrated) state.sinceMigration++;
  });

  return {
    runs: state.runs,
    migrated: state.migrated,
    legacySha: state.legacySha,
    eventsSinceMigration: state.migrated
      ? Math.max(0, state.sinceMigration - state.migrated.batch)
      : 0,
    archived: state.archived,
    drafts: state.drafts,
    lastSeq: state.lastSeq,
    maxRun: state.maxRun,
    maxPass: state.maxPass,
    issues: state.issues,
  };
}

/** The legacy view of a log: complete before the current run, its own status at it, locked after. */
export function projectStatuses(
  log: RunLog,
  currentIsReady: boolean,
): Partial<Record<PipelinePhaseId, PhaseStatus>> {
  const current = currentRun(log);
  const currentIndex = current ? log.runs.indexOf(current) : log.runs.length;
  const out: Partial<Record<PipelinePhaseId, PhaseStatus>> = {};
  log.runs.forEach((run, index) => {
    if (!run.legacyPhase) return;
    out[run.legacyPhase] =
      index < currentIndex
        ? 'complete'
        : index > currentIndex
          ? 'locked'
          : currentIsReady
            ? 'pending-completion'
            : 'active';
  });
  return out;
}
