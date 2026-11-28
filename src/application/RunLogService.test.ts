import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PIPELINE_PHASES, RUN_LOG_FILE } from '@domain/constants';
import type { IFileSystemService } from '@domain/interfaces';
import type { PhaseStatus, PipelinePhase, PipelinePhaseId, RunLog, RunOutput } from '@domain/types';
import { cleanupTempDirs } from '../test/tempDir';
import { makeFakeFs } from '../test/fakes';
import {
  SLUG,
  diffTrees,
  legacyBookAt,
  legacyConfirm,
  legacyWork,
  text,
  tree,
  type FixtureBook,
  type Variant,
} from '../test/pipelineFixtures';
import { archivePath, archiveVersions } from './archives';
import { PipelineService } from './PipelineService';
import { RunLogService } from './RunLogService';
import { ShadowPipelineService, type ShadowReport } from './ShadowPipelineService';
import { currentRun, parseRunLog, sha256Text } from './runLog';

afterEach(cleanupTempDirs);

const NO_CHANGE = { added: [], removed: [], changed: [] };

const statusMap = (phases: PipelinePhase[]): Partial<Record<PipelinePhaseId, PhaseStatus>> =>
  Object.fromEntries(phases.map((p) => [p.id, p.status]));

/**
 * A filesystem view whose writes do nothing, so today's detection (which
 * writes pipeline-state.json when it's missing or unreadable) leaves the
 * files as they are.
 */
function readOnly(fs: IFileSystemService): IFileSystemService {
  const blocked = new Set(['writeFile', 'appendFile', 'deleteFile', 'deletePath', 'renameFile', 'updateBookMeta']);
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (typeof key === 'string' && blocked.has(key)) return async () => undefined;
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Where a run's output lives now: the live file or one of its archives. */
async function locate(fs: IFileSystemService, ref: RunOutput): Promise<string | null> {
  const candidates = [ref.path, ...(await archiveVersions(fs, SLUG, ref.path)).map((v) => archivePath(ref.path, v))];
  for (const candidate of candidates) {
    const content = await fs.readFile(SLUG, candidate).catch(() => null);
    if (content !== null && sha256Text(content) === ref.sha256) return candidate;
  }
  return null;
}

/** Every finished run's outputs are the content its own legacy phase wrote. */
async function expectOutputsAttributed(b: FixtureBook, log: RunLog): Promise<void> {
  for (const run of log.runs.filter((r) => r.state === 'done')) {
    for (const ref of run.outputs) {
      const where = await locate(b.fs, ref);
      expect(where, `${run.legacyPhase} ${ref.path}`).not.toBeNull();
      const content = await b.fs.readFile(SLUG, where!);
      // Mark done on a phase with no work leaves a stub; otherwise the tag names the phase
      expect(content, `${run.legacyPhase} → ${where}`).toContain(`${run.legacyPhase}#`);
    }
  }
}

/** The four checks every migrated fixture must pass. */
async function migrateAndCheck(b: FixtureBook) {
  // Today's app on open (the state file exists, so this writes nothing)
  const legacyPhases = await b.legacy.detectPhases(SLUG);
  const before = await tree(b.dir);
  const service = new RunLogService(b.fs);

  const result = await service.migrate(SLUG, legacyPhases);
  expect(result.outcome).toBe('migrated');
  expect(result.log.issues).toEqual([]);

  // 1. The migration writes the run log and nothing else.
  const after = await tree(b.dir);
  expect(diffTrees(before, after)).toEqual({ added: [RUN_LOG_FILE], removed: [], changed: [] });

  // 2. Rollback: an older build reads the untouched files and sees the same pipeline.
  expect(statusMap(await new PipelineService(readOnly(b.fs)).detectPhases(SLUG))).toEqual(statusMap(legacyPhases));

  // 3. The log, recomputed with the files, shows the same position.
  expect(await service.projectLegacy(SLUG, result.log)).toEqual(statusMap(legacyPhases));

  // 4. Migrating again changes nothing.
  expect((await service.migrate(SLUG, legacyPhases)).outcome).toBe('up-to-date');
  expect(diffTrees(after, await tree(b.dir))).toEqual(NO_CHANGE);

  return { legacy: statusMap(legacyPhases), log: result.log, service };
}

/**
 * Drive the rest of the book through today's pipeline with shadow mode on,
 * collecting shadow reports in `reports`. At the end the log is in step
 * and every finished run's output is still on disk.
 */
async function continueInShadow(
  b: FixtureBook,
  service: RunLogService,
  reports: ShadowReport[] = [],
  shadow = new ShadowPipelineService(b.legacy, service, (r) => reports.push(r)),
): Promise<RunLog> {
  shadow.openBook(SLUG);

  for (let guard = 0; guard < 40; guard++) {
    const phases = await shadow.detectPhases(SLUG);
    const current = phases.find((p) => p.status === 'active' || p.status === 'pending-completion');
    if (!current) break;
    if (current.status === 'active') {
      await legacyWork(b, current.id, 2);
      await shadow.detectPhases(SLUG);
    }
    await legacyConfirm(shadow, current.id);
  }

  const log = await service.load(SLUG);
  expect(log.issues).toEqual([]);
  expect(log.runs.every((r) => r.state === 'done')).toBe(true);
  expect(log.legacySha).toBe(await service.legacyStateHash(SLUG));
  for (const run of log.runs) {
    for (const ref of run.outputs) {
      expect(await locate(b.fs, ref), `${run.id} ${ref.path}`).not.toBeNull();
    }
  }
  return log;
}

/** Phases whose work alone doesn't make them pending: Mark done or Complete Revision finishes them. */
const ACTION_COMPLETED = new Set<PipelinePhaseId>(['first-draft', 'revision', 'mechanical-fixes']);

const CASES: { name: string; k: number; variant: Variant; expected: PhaseStatus }[] = [
  ...PIPELINE_PHASES.flatMap((p, k) => [
    { name: `${p.id} (active)`, k, variant: 'active' as const, expected: 'active' as const },
    {
      name: `${p.id} (work done)`,
      k,
      variant: 'pending' as const,
      expected: ACTION_COMPLETED.has(p.id) ? ('active' as const) : ('pending-completion' as const),
    },
  ]),
  { name: 'finished book', k: PIPELINE_PHASES.length - 1, variant: 'complete', expected: 'complete' },
];

describe('RunLogService.migrate — fixture books at each of the 15 legacy phases', () => {
  it.each(CASES)('$name', async ({ k, variant, expected }) => {
    const b = await legacyBookAt(k, variant);
    const { legacy, log, service } = await migrateAndCheck(b);

    // The fixture really is at the intended position
    if (variant === 'complete') expect(Object.values(legacy).every((s) => s === 'complete')).toBe(true);
    else expect(legacy[PIPELINE_PHASES[k].id]).toBe(expected);

    expect(log.runs).toHaveLength(15);
    await expectOutputsAttributed(b, log);

    // Driven to the end with shadow mode on, the log never disagrees
    const reports: ShadowReport[] = [];
    await continueInShadow(b, service, reports);
    expect(reports).toEqual([]);
  });
});

describe('RunLogService.migrate — edge cases', () => {
  it('with no pipeline-state.json, records no legacy hash and writes only the log', async () => {
    const b = await legacyBookAt(10, 'active'); // through Copy Edit: two cycles
    await rm(path.join(b.dir, 'pipeline-state.json'));
    // An older build would auto-confirm on open; read-only here, so the file stays absent
    const legacy = await new PipelineService(readOnly(b.fs)).detectPhases(SLUG);
    const before = await tree(b.dir);

    const service = new RunLogService(b.fs);
    const result = await service.migrate(SLUG, legacy);

    expect(diffTrees(before, await tree(b.dir))).toEqual({ added: [RUN_LOG_FILE], removed: [], changed: [] });
    expect(result.log.migrated?.from).toMatchObject({ sha256: null, confirmedPhases: null, readable: true });
    expect(statusMap(legacy)['revision-plan-2']).toBe('active');
    expect(await service.projectLegacy(SLUG, result.log)).toEqual(statusMap(legacy));
    await expectOutputsAttributed(b, result.log);
  });

  it('an unreadable pipeline-state.json is kept, the position comes from the files, and the author is told', async () => {
    const b = await legacyBookAt(8, 'pending');
    await writeFile(path.join(b.dir, 'pipeline-state.json'), '{"confirmedPhases": ["pitch", ', 'utf-8');
    const legacy = await new PipelineService(readOnly(b.fs)).detectPhases(SLUG);
    const before = await tree(b.dir);

    const result = await new RunLogService(b.fs).migrate(SLUG, legacy);

    expect(result.notice).toMatch(/could not be read/);
    expect(result.log.migrated?.from.readable).toBe(false);
    expect(diffTrees(before, await tree(b.dir))).toEqual({ added: [RUN_LOG_FILE], removed: [], changed: [] });
  });

  it('several archives per report: each run gets the version it was confirmed with', async () => {
    const b = await legacyBookAt(3, 'active');
    await legacyWork(b, 'first-read', 1); // first attempt
    await legacyWork(b, 'first-read', 2); // re-run: attempt 1 archived as v1
    await legacyConfirm(b.legacy, 'first-read');
    for (const id of ['first-assessment', 'revision-plan-1', 'revision'] as const) {
      await legacyWork(b, id);
      await legacyConfirm(b.legacy, id);
    }
    await legacyWork(b, 'second-read', 3);
    await legacyConfirm(b.legacy, 'second-read');

    const { log } = await migrateAndCheck(b);
    const output = async (id: PipelinePhaseId) => {
      const ref = log.runs.find((r) => r.legacyPhase === id)!.outputs[0];
      return b.fs.readFile(SLUG, (await locate(b.fs, ref))!);
    };
    expect(await output('first-read')).toContain('first-read#2'); // the confirmed attempt, not the abandoned one
    expect(await output('second-read')).toContain('second-read#3');
  });

  it('a reverted book (later files on disk, unconfirmed) migrates to the reverted position', async () => {
    const b = await legacyBookAt(9, 'active'); // through Second Assessment
    await b.legacy.revertPhase(SLUG, 'first-assessment');
    const { legacy, service } = await migrateAndCheck(b);
    expect(legacy['first-assessment']).toBe('pending-completion');
    expect(legacy['second-read']).toBe('locked');

    // Known difference, reported: today's pipeline counts the plan left on
    // disk from before the revert as finished; the log's run starts fresh
    // when it is reached, so it waits for new work (or Done).
    const reports: ShadowReport[] = [];
    await continueInShadow(b, service, reports);
    expect(reports).toEqual([
      {
        kind: 'mismatch',
        bookSlug: SLUG,
        mismatches: [{ phase: 'revision-plan-1', legacy: 'pending-completion', log: 'active' }],
      },
    ]);
  });

  it('a first draft whose status an agent advanced migrates as waiting for confirmation', async () => {
    const b = await legacyBookAt(2, 'pending'); // chapters written
    await b.fs.updateBookMeta(SLUG, { status: 'revision-1' }); // Forge's status line
    const { legacy, log, service } = await migrateAndCheck(b);
    expect(legacy['first-draft']).toBe('pending-completion');
    expect(currentRun(log)).toMatchObject({ legacyPhase: 'first-draft', baseline: null });

    const reports: ShadowReport[] = [];
    await continueInShadow(b, service, reports);
    expect(reports).toEqual([]);
  });

  it('deleting the log undoes the migration: the next migration rebuilds the same plan', async () => {
    const b = await legacyBookAt(11, 'pending');
    const legacy = await b.legacy.detectPhases(SLUG);
    const before = await tree(b.dir);
    const service = new RunLogService(b.fs);

    const first = await service.migrate(SLUG, legacy);
    await rm(path.join(b.dir, RUN_LOG_FILE));
    expect(diffTrees(before, await tree(b.dir))).toEqual(NO_CHANGE);

    const second = await service.migrate(SLUG, legacy);
    expect(second.outcome).toBe('migrated');
    const shape = (log: RunLog) => log.runs.map((r) => [r.id, r.legacyPhase, r.state, r.outputs.map((o) => o.sha256)]);
    expect(shape(second.log)).toEqual(shape(first.log));
  });
});

describe('RunLogService.update', () => {
  it('appends after a torn last line on a new line, leaving the torn line in place', async () => {
    const b = await legacyBookAt(2, 'active');
    const service = new RunLogService(b.fs);
    await service.migrate(SLUG, await b.legacy.detectPhases(SLUG));
    const file = path.join(b.dir, RUN_LOG_FILE);
    const torn = '{"v":1,"seq":99,"e":"do';
    await writeFile(file, (await readFile(file, 'utf-8')) + torn, 'utf-8');

    const loaded = await service.load(SLUG);
    expect(loaded.issues).toHaveLength(1);
    expect(currentRun(loaded)?.legacyPhase).toBe('first-draft');

    const updated = await service.update(SLUG, async () => [{ e: 'legacy-synced', sha256: null }]);
    expect(updated.legacySha).toBeNull();
    expect(updated.issues).toHaveLength(1); // still only the torn line
    const raw = await readFile(file, 'utf-8');
    expect(raw).toContain(`${torn}\n{`);
  });

  it('refuses events that would be dropped on read, and writes nothing', async () => {
    const fs = makeFakeFs({}, { bookSlug: SLUG });
    const service = new RunLogService(fs);
    await expect(service.update(SLUG, async () => [{ e: 'done', run: 'r1', outputs: [] }])).rejects.toThrow(
      /refused new events: unknown run r1/,
    );
    expect(fs.files.has(`${SLUG}/${RUN_LOG_FILE}`)).toBe(false);
  });

  it('writes one book at a time: concurrent updates keep their order and sequence', async () => {
    const fs = makeFakeFs({}, { bookSlug: SLUG });
    const service = new RunLogService(fs);
    const planned = (n: number) => async (log: RunLog) => [
      {
        e: 'planned' as const,
        run: `r${log.maxRun + 1}`,
        type: 'read' as const,
        pass: 'p1',
        passKind: 'read' as const,
        after: log.runs.at(-1)?.id ?? null,
        origin: 'author' as const,
        label: `update ${n}`,
      },
    ];
    await Promise.all([1, 2, 3, 4].map((n) => service.update(SLUG, planned(n))));

    const log = parseRunLog(fs.files.get(`${SLUG}/${RUN_LOG_FILE}`)!, SLUG);
    expect(log.issues).toEqual([]);
    expect(log.runs.map((r) => [r.id, r.label])).toEqual([
      ['r1', 'update 1'],
      ['r2', 'update 2'],
      ['r3', 'update 3'],
      ['r4', 'update 4'],
    ]);
    expect(log.lastSeq).toBe(4);
  });

  it('a failed update does not block the next one', async () => {
    const fs = makeFakeFs({}, { bookSlug: SLUG });
    const service = new RunLogService(fs);
    await expect(service.update(SLUG, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const log = await service.update(SLUG, async () => [{ e: 'legacy-synced', sha256: null }]);
    expect(log.lastSeq).toBe(1);
  });
});

describe('RunLogService.isReady', () => {
  it('#87: a new report with the same word count as the last one is ready', async () => {
    const b = await legacyBookAt(7, 'active'); // Second Read: live report == newest archive
    const { service } = await migrateAndCheck(b);
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(70, 'same-length-new-read'));

    // Today's check compares word counts and misses it
    expect(statusMap(await b.legacy.detectPhases(SLUG))['second-read']).toBe('active');
    const log = await service.load(SLUG);
    expect((await service.projectLegacy(SLUG, log))['second-read']).toBe('pending-completion');
  });

  it('a report too short to count is not ready', async () => {
    const b = await legacyBookAt(3, 'active');
    const { service } = await migrateAndCheck(b);
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(10, 'too-short'));
    const log = await service.load(SLUG);
    expect(await service.isReady(SLUG, currentRun(log)!)).toBe(false);
  });
});
