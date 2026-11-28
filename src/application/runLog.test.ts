import { describe, expect, it } from 'vitest';
import type { RunEventBody } from '@domain/types';
import {
  currentRun,
  parseRunLog,
  projectStatuses,
  reopenEvents,
  sha256Text,
  stampEvents,
} from './runLog';

const SLUG = 'book';
const SHA = sha256Text('content');
const SHA2 = sha256Text('other content');

/** Serialize bodies as a log: one stamped event per line. */
function logOf(bodies: RunEventBody[], firstSeq = 0): string {
  return stampEvents(bodies, firstSeq, '2026-11-28T00:00:00.000Z')
    .map((ev) => JSON.stringify(ev))
    .join('\n') + '\n';
}

const planned = (run: string, after: string | null, extra: Partial<Extract<RunEventBody, { e: 'planned' }>> = {}): RunEventBody => ({
  e: 'planned',
  run,
  type: 'read',
  pass: 'p1',
  passKind: 'assess',
  after,
  origin: 'template',
  ...extra,
});

describe('parseRunLog', () => {
  it('reads an empty or missing log as an empty plan', () => {
    const log = parseRunLog('', SLUG);
    expect(log.runs).toEqual([]);
    expect(log.migrated).toBeNull();
    expect(log.issues).toEqual([]);
    expect(currentRun(log)).toBeNull();
  });

  it('folds planned runs in plan order, inserting after the named run', () => {
    const log = parseRunLog(
      logOf([
        planned('r1', null),
        planned('r2', 'r1', { type: 'assessment' }),
        planned('r3', 'r1', { type: 'revision-plan' }), // inserted between r1 and r2
      ]),
      SLUG,
    );
    expect(log.runs.map((r) => r.id)).toEqual(['r1', 'r3', 'r2']);
    expect(log.maxRun).toBe(3);
    expect(log.issues).toEqual([]);
  });

  it('runs a run through started, done and reopened', () => {
    const raw = logOf([
      planned('r1', null),
      planned('r2', 'r1', { type: 'assessment' }),
      { e: 'started', run: 'r1', baseline: { 'source/reader-report.md': null } },
      { e: 'done', run: 'r1', outputs: [{ path: 'source/reader-report.md', sha256: SHA, words: 70 }] },
      { e: 'started', run: 'r2', baseline: { 'source/dev-report.md': null } },
    ]);
    const log = parseRunLog(raw, SLUG);
    expect(log.runs[0]).toMatchObject({ state: 'done', outputs: [{ sha256: SHA }] });
    expect(currentRun(log)?.id).toBe('r2');

    // Only done or skipped runs reopen
    const reopen = reopenEvents(log, ['r1', 'r2']);
    expect(reopen).toEqual([{ e: 'reopened', run: 'r1' }]);

    const after = parseRunLog(raw + logOf(reopen, log.lastSeq), SLUG);
    expect(after.issues).toEqual([]);
    expect(after.runs[0]).toMatchObject({ state: 'active', outputs: [] });
    expect(currentRun(after)?.id).toBe('r1');
  });

  it('an agent-origin run is proposed until approved or declined', () => {
    const log = parseRunLog(
      logOf([
        planned('r1', null, { origin: 'agent', proposedBy: 'Quill', type: 'copy-edit', passKind: 'copy-edit' }),
        planned('r2', 'r1', { origin: 'agent', proposedBy: 'Quill', type: 'fix-plan', passKind: 'copy-edit' }),
        { e: 'approved', run: 'r1' },
        { e: 'declined', run: 'r2' },
      ]),
      SLUG,
    );
    expect(log.runs.map((r) => r.state)).toEqual(['planned', 'declined']);
  });

  it('a migrated event starts a new epoch; run IDs are never reused', () => {
    const migrated = (batch: number): RunEventBody => ({
      e: 'migrated',
      from: { file: 'pipeline-state.json', sha256: SHA, confirmedPhases: [], readable: true },
      legacy: { pitch: 'active' },
      batch,
    });
    const log = parseRunLog(
      logOf([
        migrated(1),
        planned('r1', null),
        migrated(1),
        planned('r1', null), // reused ID: dropped
        planned('r2', null),
        { e: 'started', run: 'r2', baseline: { 'source/reader-report.md': null } },
      ]),
      SLUG,
    );
    expect(log.runs.map((r) => r.id)).toEqual(['r2']);
    expect(log.issues).toEqual([{ line: 4, reason: 'run r1 already exists' }]);
    expect(log.legacySha).toBe(SHA);
    // One migration event in the batch, one after it
    expect(log.eventsSinceMigration).toBe(1);
  });

  it('legacy-synced moves the hash the log knows', () => {
    const log = parseRunLog(logOf([{ e: 'legacy-synced', sha256: SHA2 }]), SLUG);
    expect(log.legacySha).toBe(SHA2);
  });

  it('reopening a migrated run that was waiting clears its unknown baseline', () => {
    const log = parseRunLog(
      logOf([
        planned('r1', null, { type: 'draft', passKind: 'draft' }),
        { e: 'started', run: 'r1', baseline: null },
        { e: 'done', run: 'r1', outputs: [] },
        { e: 'reopened', run: 'r1' },
      ]),
      SLUG,
    );
    expect(log.runs[0].state).toBe('active');
    expect(log.runs[0].baseline).toBeUndefined();
  });

  it('a torn last line is reported and skipped; earlier lines still fold', () => {
    const raw = logOf([planned('r1', null)]) + '{"v":1,"seq":2,"e":"do';
    const log = parseRunLog(raw, SLUG);
    expect(log.runs).toHaveLength(1);
    expect(log.issues).toEqual([{ line: 2, reason: 'unreadable line' }]);
  });
});

describe('parseRunLog validation (events are dropped, not folded)', () => {
  const base = [planned('r1', null)];

  const cases: { name: string; event: Record<string, unknown>; reason: RegExp }[] = [
    { name: 'unknown event', event: { e: 'teleported', run: 'r1' }, reason: /unknown event/ },
    { name: 'unknown phase type', event: { ...planned('r2', 'r1'), type: 'nap' }, reason: /unknown phase type/ },
    { name: 'bad run id', event: { e: 'done', run: '../r1', outputs: [] }, reason: /bad run id/ },
    { name: 'unknown run', event: { e: 'done', run: 'r9', outputs: [] }, reason: /unknown run r9/ },
    { name: 'insert after an unknown run', event: planned('r2', 'r7'), reason: /unknown run r7/ },
    { name: 'illegal transition', event: { e: 'reopened', run: 'r1' }, reason: /not allowed for a planned run/ },
    { name: 'approve a run nobody proposed', event: { e: 'approved', run: 'r1' }, reason: /not allowed/ },
    {
      name: 'an output the type does not write',
      event: { e: 'done', run: 'r1', outputs: [{ path: 'source/dev-report.md', sha256: SHA, words: 1 }] },
      reason: /outputs don't match/,
    },
    {
      name: 'a baseline for a file the type does not write',
      event: { e: 'started', run: 'r1', baseline: { 'about.json': SHA } },
      reason: /baseline names a file/,
    },
    {
      name: 'a path outside the book',
      event: { e: 'done', run: 'r1', outputs: [{ path: '../other/source/reader-report.md', sha256: SHA, words: 1 }] },
      reason: /bad outputs/,
    },
    { name: 'a hash that is not sha256', event: { e: 'legacy-synced', sha256: 'abc' }, reason: /bad hash/ },
    {
      name: 'an archive that is not a version of its file',
      event: { e: 'archived', path: 'source/reader-report.md', to: 'about.json', sha256: SHA },
      reason: /not a version of its file/,
    },
    {
      name: 'a draft chapter outside its folder',
      event: { e: 'snapshot', draft: 1, reason: 'x', chapters: [{ slug: '../chapters', sha256: SHA, words: 1 }] },
      reason: /bad chapters/,
    },
    { name: 'an unknown agent', event: { ...planned('r2', 'r1'), origin: 'agent', proposedBy: 'Mallory' }, reason: /unknown agent/ },
    {
      name: 'an unknown legacy phase',
      event: { ...planned('r2', 'r1'), legacyPhase: 'third-read' },
      reason: /unknown legacy phase/,
    },
  ];

  it.each(cases)('$name', ({ event, reason }) => {
    const line = JSON.stringify({ ...event, v: 1, seq: 2, at: '2026-11-28T00:00:00.000Z' });
    const log = parseRunLog(logOf(base) + line + '\n', SLUG);
    expect(log.issues).toHaveLength(1);
    expect(log.issues[0].line).toBe(2);
    expect(log.issues[0].reason).toMatch(reason);
    // The valid line still folds, untouched by the bad one
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].state).toBe('planned');
    expect(log.lastSeq).toBe(1);
  });

  it('drops an event whose sequence number does not increase', () => {
    const raw = logOf(base) + JSON.stringify({ e: 'skipped', run: 'r1', reason: 'x', v: 1, seq: 1, at: 'now' }) + '\n';
    const log = parseRunLog(raw, SLUG);
    expect(log.issues[0].reason).toMatch(/sequence 1 is not after 1/);
    expect(log.runs[0].state).toBe('planned');
  });

  it('drops a draft snapshot that does not come after the last one', () => {
    const snapshot = (draft: number): RunEventBody => ({ e: 'snapshot', draft, reason: 'x', chapters: [] });
    const log = parseRunLog(logOf([snapshot(2), snapshot(2)]), SLUG);
    expect(log.drafts.map((d) => d.draft)).toEqual([2]);
    expect(log.issues[0].reason).toMatch(/not after draft 2/);
  });

  it('accepts an archive event for a real version of the file', () => {
    const log = parseRunLog(
      logOf([{ e: 'archived', path: 'source/reader-report.md', to: 'source/reader-report-v3.md', sha256: SHA }]),
      SLUG,
    );
    expect(log.issues).toEqual([]);
    expect(log.archived).toHaveLength(1);
  });
});

describe('projectStatuses', () => {
  const log = parseRunLog(
    logOf([
      planned('r1', null, { type: 'pitch', passKind: 'conceive', legacyPhase: 'pitch' }),
      planned('r2', 'r1', { type: 'scaffold', passKind: 'conceive', legacyPhase: 'scaffold' }),
      planned('r3', 'r2', { type: 'draft', passKind: 'draft', legacyPhase: 'first-draft' }),
      { e: 'done', run: 'r1', outputs: [] },
      { e: 'started', run: 'r2', baseline: null },
    ]),
    SLUG,
  );

  it('complete before the current run, its own status at it, locked after', () => {
    expect(projectStatuses(log, true)).toEqual({
      pitch: 'complete',
      scaffold: 'pending-completion',
      'first-draft': 'locked',
    });
    expect(projectStatuses(log, false).scaffold).toBe('active');
  });

  it('everything is complete when no run is left', () => {
    const finished = parseRunLog(
      logOf([planned('r1', null, { type: 'pitch', passKind: 'conceive', legacyPhase: 'pitch' }), { e: 'skipped', run: 'r1', reason: 'x' }]),
      SLUG,
    );
    expect(projectStatuses(finished, false)).toEqual({ pitch: 'complete' });
  });
});
