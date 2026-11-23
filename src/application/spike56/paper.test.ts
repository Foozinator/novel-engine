// THROWAWAY — spike #56 (iteration model). "Paper" tests of the new model; not for merge.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../../test/tempDir';
import { RunEngine, sha256 } from './engine';
import { SLUG, diffTrees, freshBook, newWork, text, tree, type Book } from './fixtures';
import { DEFAULT_PLAN, PHASE_TYPES, type PhaseType } from './model';
import { RUN_LOG_PATH, currentRun, ordinalOf, type Folded, type Run } from './runLog';

afterEach(cleanupTempDirs);

/** Start (if needed), let the "agent" work, confirm. Returns the run as done. */
async function runOnce(b: Book, engine: RunEngine, tag?: string): Promise<{ folded: Folded; run: Run }> {
  let folded = await engine.load();
  const cur = currentRun(folded)!;
  if (cur.state === 'planned') folded = await engine.start(cur.id);
  const run = folded.runs.find((r) => r.id === cur.id)!;
  await newWork(b, run.phase, tag ?? `${run.id}-${run.phase}`);
  expect(await engine.isPending(run)).toBe(PHASE_TYPES[run.phase].gate === 'files');
  folded = await engine.done(run.id);
  return { folded, run: folded.runs.find((r) => r.id === cur.id)! };
}

/** Run until the current run is of `type` (not yet started), or the plan ends. */
async function runUntil(b: Book, engine: RunEngine, type: PhaseType | null): Promise<Folded> {
  let folded = await engine.load();
  for (let guard = 0; guard < 80; guard++) {
    const cur = currentRun(folded);
    if (!cur || (type && cur.phase === type && cur.state === 'planned')) return folded;
    folded = (await runOnce(b, engine)).folded;
  }
  throw new Error('runaway');
}

async function contents(engine: RunEngine, b: Book, folded: Folded, type: PhaseType): Promise<string[]> {
  const out: string[] = [];
  for (const run of folded.runs.filter((r) => r.phase === type && r.state === 'done')) {
    for (const ref of run.outputs) {
      const where = await engine.resolve(ref, folded);
      expect(where, `${run.id} ${ref.path}`).not.toBeNull();
      out.push(await b.fs.readFile(SLUG, where!));
    }
  }
  return out;
}

describe('spike #56 — #87 done-when: four revisions and three copy edits', () => {
  it('runs them without a revert, and keeps every report, plan and draft', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await engine.planDefault(DEFAULT_PLAN);

    // Revision pass 1 is in the default plan. Add passes 2–4 at the copy edit.
    await runUntil(b, engine, 'copy-edit');
    for (let i = 0; i < 3; i++) {
      await engine.addPass('revision');
      await runUntil(b, engine, 'copy-edit');
    }
    // Copy edit 1 is in the default plan. Add 2 and 3 when the build comes up.
    await runUntil(b, engine, 'build');
    for (let i = 0; i < 2; i++) {
      const { runIds } = await engine.addPass('copy-edit');
      expect(runIds).toHaveLength(3); // the build follow-on is dropped: the build is next anyway
      await runUntil(b, engine, 'build');
    }
    const folded = await runUntil(b, engine, null);

    const done = (t: PhaseType) => folded.runs.filter((r) => r.phase === t && r.state === 'done').length;
    expect(done('revision')).toBe(4);
    expect(done('copy-edit')).toBe(3);
    expect(done('read')).toBe(5);
    expect(done('assessment')).toBe(5);

    // Every report and plan is retrievable, and each run's is its own.
    for (const type of ['read', 'assessment', 'copy-edit', 'revision-plan', 'fix-plan'] as PhaseType[]) {
      const texts = await contents(engine, b, folded, type);
      expect(new Set(texts.map(sha256)).size, type).toBe(texts.length);
    }
    expect(await contents(engine, b, folded, 'revision-plan')).toHaveLength(8); // 4 plans × 2 files
    expect(await contents(engine, b, folded, 'fix-plan')).toHaveLength(6);

    // A draft snapshot before every rewriting run after the first draft: 4 revisions + 3 fix runs.
    expect(folded.drafts.map((d) => d.draft)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const ch1 = await b.fs.readFile(SLUG, 'chapters/01-one/draft.md');
    await engine.restoreDraft(1);
    const restored = await b.fs.readFile(SLUG, 'chapters/01-one/draft.md');
    expect(restored).toBe(await b.fs.readFile(SLUG, 'drafts/draft-01/01-one.md'));
    expect(restored).not.toBe(ch1);
    // Restoring snapshotted the text it replaced first.
    const after = await engine.load();
    expect(after.drafts).toHaveLength(8);
    expect(await b.fs.readFile(SLUG, 'drafts/draft-08/01-one.md')).toBe(ch1);
  });
});

describe('spike #56 — acceptance cases from the design comment', () => {
  it('1. Quill flags copy-edit blockers at Publish → proposes a pass → approved → runs without a revert', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await engine.planDefault(DEFAULT_PLAN);
    let folded = await runUntil(b, engine, 'publish');
    const publish = currentRun(folded)!;
    folded = await engine.start(publish.id);

    // Quill proposes; nothing moves until the author approves.
    const { runIds } = await engine.addPass('copy-edit', {
      origin: 'agent',
      proposedBy: 'Quill',
      reason: 'Unresolved audit items are blockers',
    });
    folded = await engine.load();
    expect(runIds.map((id) => folded.runs.find((r) => r.id === id)!.phase)).toEqual([
      'copy-edit',
      'fix-plan',
      'mechanical-fixes',
      'build',
    ]);
    expect(folded.runs.filter((r) => r.state === 'proposed')).toHaveLength(4);
    expect(currentRun(folded)!.id).toBe(publish.id);

    folded = await engine.approvePass(folded.runs.find((r) => r.id === runIds[0])!.pass);
    expect(currentRun(folded)!.id).toBe(runIds[0]);
    expect(folded.runs.find((r) => r.id === publish.id)!.state).toBe('planned'); // deferred

    folded = await runUntil(b, engine, null);
    const copyEdits = folded.runs.filter((r) => r.phase === 'copy-edit');
    expect(copyEdits.map((r) => r.state)).toEqual(['done', 'done']);
    expect(copyEdits.map((r) => ordinalOf(folded, r.id))).toEqual([1, 2]);
    expect(new Set((await contents(engine, b, folded, 'copy-edit')).map(sha256)).size).toBe(2);
    expect(folded.runs.filter((r) => r.phase === 'build' && r.state === 'done')).toHaveLength(2);
  });

  it('2. a third revision pass after Second Assessment works the same way', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await engine.planDefault(DEFAULT_PLAN);
    await runUntil(b, engine, 'copy-edit');
    await engine.addPass('revision');
    await runUntil(b, engine, 'copy-edit');
    await engine.addPass('revision');
    const folded = await runUntil(b, engine, 'copy-edit');
    expect(folded.runs.filter((r) => r.phase === 'revision' && r.state === 'done')).toHaveLength(3);
    expect(folded.runs.filter((r) => r.passKind === 'revision').map((r) => r.pass)).toHaveLength(12);
  });

  it('3. sequel (#62): two cold reads, then one assessment that reads both', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await engine.planDefault(DEFAULT_PLAN);
    await runUntil(b, engine, 'read');
    await runOnce(b, engine, 'new-reader');
    await engine.addPass('read', { label: 'Returning reader' });
    await runOnce(b, engine, 'returning-reader');

    const folded = await engine.load();
    const assessment = currentRun(folded)!;
    expect(assessment.phase).toBe('assessment');
    const inputs = engine.inputsFor(folded, assessment.id);
    expect(inputs).toHaveLength(2);
    const texts = await Promise.all(
      inputs.map(async (ref) => b.fs.readFile(SLUG, (await engine.resolve(ref, folded))!)),
    );
    expect(texts[0]).toContain('new-reader');
    expect(texts[1]).toContain('returning-reader');
    // The first is already in an archive; the second is the live file.
    expect(await engine.resolve(inputs[0], folded)).toBe('source/reader-report-v1.md');
    expect(await engine.resolve(inputs[1], folded)).toBe('source/reader-report.md');
  });
});

describe('spike #56 — entry and exit cases (#88, #93, #89)', () => {
  /** An imported manuscript: chapters on disk, Draft 1 snapshotted, earlier runs skipped. No placeholder files. */
  async function importBook(kind: 'partial' | 'complete' | 'revised' | 'edited') {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await b.fs.writeFile(SLUG, 'chapters/01-one/draft.md', text(900, 'imported/one'));
    await b.fs.writeFile(SLUG, 'chapters/02-two/draft.md', text(900, 'imported/two'));
    const before = await tree(b.dir);

    let folded = await engine.planDefault(DEFAULT_PLAN, 'import');
    const snap = await engine.snapshotDraft(folded, 'import');
    folded = await engine.append([snap!]);
    const byType = (t: PhaseType, n = 1) => folded.runs.filter((r) => r.phase === t)[n - 1];

    folded = await engine.skip(byType('pitch').id, 'import');
    folded = await engine.skip(byType('scaffold').id, 'import');
    if (kind !== 'partial') {
      folded = await engine.done(byType('draft').id);
      // #89: a readiness check right after the first cold read.
      await engine.addPass('readiness', { afterRun: byType('read').id });
      folded = await engine.load();
    }
    if (kind === 'edited') {
      for (const t of ['assessment', 'revision-plan', 'revision'] as PhaseType[]) folded = await engine.skip(byType(t).id, 'import: edited manuscript');
      folded = await engine.skip(byType('read', 2).id, 'import: edited manuscript');
      folded = await engine.skip(byType('assessment', 2).id, 'import: edited manuscript');
    }

    const changes = diffTrees(before, await tree(b.dir));
    return { b, engine, folded, changes };
  }

  it.each(['partial', 'complete', 'revised', 'edited'] as const)('#88 import of a %s manuscript lands on a pass with no placeholder files', async (kind) => {
    const { folded, changes } = await importBook(kind);
    expect(changes.changed).toEqual([]);
    expect(changes.removed).toEqual([]);
    expect(changes.added.filter((p) => p !== RUN_LOG_PATH && !p.startsWith('drafts/draft-01/'))).toEqual([]);
    expect(folded.drafts[0]).toMatchObject({ draft: 1, reason: 'import' });
    const expected: Record<typeof kind, PhaseType> = { partial: 'draft', complete: 'read', revised: 'read', edited: 'read' };
    expect(currentRun(folded)!.phase).toBe(expected[kind]);
  });

  it('#93: no scaffold — three chapters, then a cold read, no placeholder files', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    let folded = await engine.planDefault(DEFAULT_PLAN);
    folded = (await runOnce(b, engine)).folded; // pitch
    folded = await engine.skip(currentRun(folded)!.id, 'author: grow section by section');
    const draft = currentRun(folded)!;
    folded = await engine.start(draft.id);
    for (const n of ['01-one', '02-two', '03-three']) {
      await b.fs.writeFile(SLUG, `chapters/${n}/draft.md`, text(500, `section/${n}`));
    }
    folded = await engine.done(draft.id);
    expect(currentRun(folded)!.phase).toBe('read');
    expect(await b.fs.fileExists(SLUG, 'source/scene-outline.md')).toBe(false);
    await runOnce(b, engine);
  });

  it('#89: two readiness checks keep both reports, and the second reads the first', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    await engine.planDefault(DEFAULT_PLAN);
    await runUntil(b, engine, 'revision-plan');
    await engine.addPass('readiness');
    await runOnce(b, engine, 'check-1');
    await runUntil(b, engine, 'copy-edit');
    await engine.addPass('readiness');
    const folded = await engine.load();
    const second = currentRun(folded)!;
    const prev = engine.inputsFor(folded, second.id)[0];
    expect(await b.fs.readFile(SLUG, (await engine.resolve(prev, folded))!)).toContain('check-1');
    await runOnce(b, engine, 'check-2');
    const end = await engine.load();
    expect((await contents(engine, b, end, 'readiness')).map((t) => t.includes('check-2'))).toEqual([false, true]);
  });

  it('#87 bug: "Done" on a skipped step writes nothing but the log', async () => {
    const b = await freshBook();
    const engine = new RunEngine(b.fs, SLUG);
    const folded = await engine.planDefault(DEFAULT_PLAN);
    const before = await tree(b.dir);
    await engine.skip(folded.runs[0].id, 'author');
    await engine.skip(folded.runs[1].id, 'author');
    expect(diffTrees(before, await tree(b.dir)).added).toEqual([]);
    expect(diffTrees(before, await tree(b.dir)).changed).toEqual([RUN_LOG_PATH]);
  });
});
