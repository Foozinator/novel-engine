// THROWAWAY — spike #56 (iteration model). Proof tests only; not for merge.
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PIPELINE_PHASES } from '@domain/constants';
import type { PhaseStatus } from '@domain/types';
import { cleanupTempDirs } from '../../test/tempDir';
import { RunEngine } from './engine';
import {
  SLUG,
  diffTrees,
  legacyBookAt,
  legacyConfirm,
  legacyWork,
  newWork,
  text,
  tree,
  type Book,
  type Variant,
} from './fixtures';
import { legacyStatuses, migrateBook, projectLegacy } from './migrate';
import { PHASE_TYPES } from './model';
import { RUN_LOG_PATH, currentRun, parseLog } from './runLog';

afterEach(cleanupTempDirs);

/** Each of today's 15 positions, before and after the phase's work, plus a finished book. */
const CASES: { k: number; variant: Variant; expect: PhaseStatus }[] = [
  ...PIPELINE_PHASES.flatMap((p, k) => [
    { k, variant: 'active' as const, expect: 'active' as const },
    // Revision is completed only by "Complete Revision", so its work alone leaves it active.
    { k, variant: 'pending' as const, expect: p.id === 'revision' ? ('active' as const) : ('pending-completion' as const) },
  ]),
  { k: PIPELINE_PHASES.length - 1, variant: 'complete', expect: 'complete' },
];

/** Assertions every migrated fixture must pass. */
async function migrateAndCheck(b: Book) {
  const before = await tree(b.dir);
  const legacyBefore = await legacyStatuses(b.fs, SLUG);

  const result = await migrateBook(b.fs, SLUG);
  expect(result.outcome).toBe('migrated');

  // 1. The migration writes the run log and nothing else.
  const after = await tree(b.dir);
  expect(diffTrees(before, after)).toEqual({ added: [RUN_LOG_PATH], removed: [], changed: [] });

  // 2. Rollback: an older build reads the untouched files and sees the same pipeline.
  expect(await legacyStatuses(b.fs, SLUG)).toEqual(legacyBefore);

  // 3. The new model, recomputed from the log and the files, shows the same position.
  expect(await projectLegacy(b.fs, SLUG)).toEqual(legacyBefore);

  // 4. Migrating again changes nothing.
  expect((await migrateBook(b.fs, SLUG)).outcome).toBe('up-to-date');
  expect(diffTrees(after, await tree(b.dir))).toEqual({ added: [], removed: [], changed: [] });

  return { legacyBefore, folded: result.folded };
}

/** Every finished run's outputs resolve to the content its own phase wrote. */
async function expectOutputsAttributed(b: Book) {
  const engine = new RunEngine(b.fs, SLUG);
  const folded = await engine.load();
  for (const run of folded.runs.filter((r) => r.state === 'done')) {
    for (const ref of run.outputs) {
      const where = await engine.resolve(ref, folded);
      expect(where, `${run.legacyPhase} ${ref.path}`).not.toBeNull();
      const content = await b.fs.readFile(SLUG, where!);
      expect(content, `${run.legacyPhase} → ${where}`).toContain(`${run.legacyPhase}#`);
    }
  }
}

/** Drive the rest of the book under the new model; every run's output stays retrievable. */
async function continueToEnd(b: Book) {
  const engine = new RunEngine(b.fs, SLUG);
  let folded = await engine.load();
  for (let guard = 0; guard < 40; guard++) {
    const cur = currentRun(folded);
    if (!cur) break;
    if (cur.state === 'planned') folded = await engine.start(cur.id);
    const run = folded.runs.find((r) => r.id === cur.id)!;
    if (!(await engine.isPending(run))) {
      await newWork(b, run.phase, `${run.id}-${run.phase}`);
      expect(await engine.isPending(run), `${run.id} ${run.phase}`).toBe(PHASE_TYPES[run.phase].gate === 'files');
    }
    folded = await engine.done(run.id);
  }
  expect(folded.runs.every((r) => r.state === 'done')).toBe(true);
  for (const run of folded.runs) {
    for (const ref of run.outputs) {
      const where = await engine.resolve(ref, folded);
      expect(where, `${run.id} ${ref.path}`).not.toBeNull();
    }
  }
}

describe('spike #56 — migration of fixture books at each of today’s 15 phases', () => {
  it.each(CASES.map((c) => ({ ...c, name: `${PIPELINE_PHASES[c.k].id} (${c.variant})` })))(
    '$name',
    async ({ k, variant, expect: expected }) => {
      const b = await legacyBookAt(k, variant);
      const { legacyBefore } = await migrateAndCheck(b);
      // The fixture really is at the intended position.
      if (variant !== 'complete') expect(legacyBefore[PIPELINE_PHASES[k].id]).toBe(expected);
      else expect(Object.values(legacyBefore).every((s) => s === 'complete')).toBe(true);
      await expectOutputsAttributed(b);
      await continueToEnd(b);
    },
  );
});

describe('spike #56 — migration edge cases', () => {
  it('a book with no pipeline-state.json (old upgrade path) migrates to the auto-confirmed position, writing nothing else', async () => {
    const b = await legacyBookAt(10, 'active'); // through Copy Edit, two cycles
    await rm(path.join(b.dir, 'pipeline-state.json'));
    const { legacyBefore, folded } = await migrateAndCheck(b);
    expect(legacyBefore['revision-plan-2']).toBe('active');
    expect(folded.migrated?.from.sha256).toBeNull();
    await expectOutputsAttributed(b);
  });

  it('an unreadable pipeline-state.json is kept, the position comes from the files, and the author is told', async () => {
    const b = await legacyBookAt(8, 'pending');
    await writeFile(path.join(b.dir, 'pipeline-state.json'), '{"confirmedPhases": ["pitch", ', 'utf-8');
    const before = await tree(b.dir);
    const result = await migrateBook(b.fs, SLUG);
    expect(result.notice).toMatch(/could not be read/);
    expect(result.folded.migrated?.from.readable).toBe(false);
    expect(diffTrees(before, await tree(b.dir))).toEqual({ added: [RUN_LOG_PATH], removed: [], changed: [] });
    expect(await projectLegacy(b.fs, SLUG)).toEqual(await legacyStatuses(b.fs, SLUG));
  });

  it('several archives per report (re-run reads, #81): each run gets the version it was confirmed with', async () => {
    const b = await legacyBookAt(3, 'active');
    await legacyWork(b, 'first-read', 1); // first attempt
    await legacyWork(b, 'first-read', 2); // re-run: attempt 1 archived as v1
    await legacyConfirm(b, 'first-read');
    for (const id of ['first-assessment', 'revision-plan-1', 'revision'] as const) {
      await legacyWork(b, id);
      await legacyConfirm(b, id);
    }
    await legacyWork(b, 'second-read', 3);
    await legacyConfirm(b, 'second-read');
    await migrateAndCheck(b);

    const engine = new RunEngine(b.fs, SLUG);
    const folded = await engine.load();
    const read = (id: string) => folded.runs.find((r) => r.legacyPhase === id)!.outputs[0];
    const first = await b.fs.readFile(SLUG, (await engine.resolve(read('first-read'), folded))!);
    const second = await b.fs.readFile(SLUG, (await engine.resolve(read('second-read'), folded))!);
    expect(first).toContain('first-read#2'); // the confirmed attempt, not the abandoned one
    expect(second).toContain('second-read#3');
  });

  it('a reverted book (later files on disk, unconfirmed) migrates to the reverted position', async () => {
    const b = await legacyBookAt(9, 'active'); // through Second Assessment
    await b.legacy.revertPhase(SLUG, 'first-assessment');
    const { legacyBefore } = await migrateAndCheck(b);
    expect(legacyBefore['first-assessment']).toBe('pending-completion');
    expect(legacyBefore['second-read']).toBe('locked');
  });

  it('after an older build moved the book on, the log re-migrates if it holds only the migration', async () => {
    const b = await legacyBookAt(4, 'pending');
    await migrateBook(b.fs, SLUG);
    // Rollback period: the older build confirms First Assessment.
    await legacyConfirm(b, 'first-assessment');
    const result = await migrateBook(b.fs, SLUG);
    expect(result.outcome).toBe('remigrated');
    expect(await projectLegacy(b.fs, SLUG)).toEqual(await legacyStatuses(b.fs, SLUG));
    // The first epoch is still in the file: append-only.
    const { events } = parseLog(await b.fs.readFile(SLUG, RUN_LOG_PATH));
    expect(events.filter((e) => e.e === 'migrated')).toHaveLength(2);
  });

  it('after newer work in the log, a changed legacy file is a conflict and the log is kept', async () => {
    const b = await legacyBookAt(4, 'pending');
    const engine = new RunEngine(b.fs, SLUG);
    await migrateBook(b.fs, SLUG);
    const run = currentRun(await engine.load())!;
    await engine.done(run.id); // work recorded only in the new model
    await legacyConfirm(b, 'first-assessment'); // older build used meanwhile
    const result = await migrateBook(b.fs, SLUG);
    expect(result.outcome).toBe('conflict');
    expect(currentRun(result.folded)?.legacyPhase).toBe('revision-plan-1');
  });

  it('deleting the log undoes the migration: the next open migrates again to the same position', async () => {
    const b = await legacyBookAt(11, 'pending');
    const before = await tree(b.dir);
    const first = await migrateBook(b.fs, SLUG);
    await rm(path.join(b.dir, RUN_LOG_PATH));
    expect(diffTrees(before, await tree(b.dir))).toEqual({ added: [], removed: [], changed: [] });
    const second = await migrateBook(b.fs, SLUG);
    expect(second.outcome).toBe('migrated');
    const shape = (f: typeof first.folded) => f.runs.map((r) => [r.id, r.legacyPhase, r.state, r.outputs.map((o) => o.sha256)]);
    expect(shape(second.folded)).toEqual(shape(first.folded));
  });

  it('a torn last line (crash mid-write) is skipped, not fatal', async () => {
    const b = await legacyBookAt(2, 'active');
    await migrateBook(b.fs, SLUG);
    const file = path.join(b.dir, RUN_LOG_PATH);
    await writeFile(file, (await readFile(file, 'utf-8')) + '{"v":1,"seq":99,"e":"do', 'utf-8');
    const folded = await new RunEngine(b.fs, SLUG).load();
    expect(folded.badLines).toBe(1);
    expect(currentRun(folded)?.legacyPhase).toBe('first-draft');
  });

  it('#87 bug: a new report with the same word count as the last one is recognized', async () => {
    const b = await legacyBookAt(7, 'active'); // Second Read, live report == archive
    await migrateBook(b.fs, SLUG);
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(70, 'same-length-new-read'));
    expect((await legacyStatuses(b.fs, SLUG))['second-read']).toBe('active'); // legacy misses it
    expect((await projectLegacy(b.fs, SLUG))['second-read']).toBe('pending-completion');
  });
});
