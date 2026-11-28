import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_LOG_FILE } from '@domain/constants';
import type { IRunLogService } from '@domain/interfaces';
import type { PipelinePhase } from '@domain/types';
import { cleanupTempDirs } from '../test/tempDir';
import { SLUG, legacyBookAt, legacyConfirm, legacyWork, text, tree, diffTrees } from '../test/pipelineFixtures';
import { RunLogService } from './RunLogService';
import { ShadowPipelineService, type ShadowReport } from './ShadowPipelineService';
import { currentRun, parseRunLog } from './runLog';

afterEach(cleanupTempDirs);

async function setup(k: number, variant: 'active' | 'pending' | 'complete' = 'active') {
  const b = await legacyBookAt(k, variant);
  const runLog = new RunLogService(b.fs);
  const reports: ShadowReport[] = [];
  const shadow = new ShadowPipelineService(b.legacy, runLog, (r) => reports.push(r));
  const events = async () => parseRunLog(await readFile(path.join(b.dir, RUN_LOG_FILE), 'utf-8'), SLUG);
  return { b, runLog, reports, shadow, events };
}

describe('ShadowPipelineService', () => {
  it('returns exactly what today’s pipeline returns, and writes nothing for a book that was never opened', async () => {
    const { b, shadow, reports } = await setup(4, 'pending');
    const before = await tree(b.dir);

    const phases = await shadow.detectPhases(SLUG);

    expect(phases).toEqual(await b.legacy.detectPhases(SLUG));
    expect(diffTrees(before, await tree(b.dir))).toEqual({ added: [], removed: [], changed: [] });
    expect(reports).toEqual([]);
  });

  it('migrates an opened book on its next detection, once', async () => {
    const { b, shadow, reports, events } = await setup(4, 'pending');
    shadow.openBook(SLUG);

    const phases = await shadow.detectPhases(SLUG);
    await shadow.detectPhases(SLUG);

    expect(phases).toEqual(await b.legacy.detectPhases(SLUG));
    expect(reports).toEqual([{ kind: 'migrated', bookSlug: SLUG, notice: null }]);
    expect((await events()).runs).toHaveLength(15);
  });

  it('keeps checking a book with a log even after another book is opened', async () => {
    const { b, runLog, shadow, reports } = await setup(4, 'pending');
    await runLog.migrate(SLUG, await b.legacy.detectPhases(SLUG));

    // Not opened in this session, but it has a log: an older build moved it on
    await b.legacy.confirmPhaseAdvancement(SLUG, 'first-assessment');
    await shadow.detectPhases(SLUG);

    expect(reports).toEqual([{ kind: 'remigrated', bookSlug: SLUG, notice: null }]);
  });

  it('mirrors Advance: the run is done, the next one starts, and the log notes the new state file', async () => {
    const { runLog, shadow, reports, events } = await setup(4, 'pending');
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);

    await shadow.confirmPhaseAdvancement(SLUG, 'first-assessment');

    const log = await events();
    const tail = log.runs.filter((r) => r.legacyPhase === 'first-assessment' || r.legacyPhase === 'revision-plan-1');
    expect(tail.map((r) => r.state)).toEqual(['done', 'active']);
    expect(tail[0].outputs.map((o) => o.path)).toEqual(['source/dev-report.md']);
    expect(log.legacySha).toBe(await runLog.legacyStateHash(SLUG));

    await shadow.detectPhases(SLUG);
    expect(reports.filter((r) => r.kind !== 'migrated')).toEqual([]);
  });

  it('mirrors Revert as reopened runs; legacy and log agree right after', async () => {
    const { b, runLog, shadow, reports, events } = await setup(9); // at Copy Edit
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);

    await shadow.revertPhase(SLUG, 'first-assessment');

    const log = await events();
    const reopened = log.runs.filter((r) => r.state === 'active').map((r) => r.legacyPhase);
    // The target and every later finished run; Copy Edit was already active
    expect(reopened).toEqual([
      'first-assessment',
      'revision-plan-1',
      'revision',
      'second-read',
      'second-assessment',
      'copy-edit',
    ]);
    expect(currentRun(log)?.legacyPhase).toBe('first-assessment');
    const legacy = Object.fromEntries((await b.legacy.detectPhases(SLUG)).map((p) => [p.id, p.status]));
    expect(await runLog.projectLegacy(SLUG, log)).toEqual(legacy);

    await shadow.detectPhases(SLUG);
    expect(reports.filter((r) => r.kind !== 'migrated')).toEqual([]);
  });

  it('after a revert and a redone revision, reports where the reads differ', async () => {
    const { b, shadow, reports } = await setup(9);
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);
    await shadow.revertPhase(SLUG, 'first-assessment');

    for (const id of ['first-assessment', 'revision-plan-1'] as const) await legacyConfirm(shadow, id);
    await legacyWork(b, 'revision', 2);
    await shadow.completeRevision(SLUG);
    await shadow.detectPhases(SLUG);

    // Known difference: Complete Revision archived the old reader report, so
    // today's pipeline wants a new read; the reopened run still has its report.
    expect(reports.filter((r) => r.kind === 'mismatch')).toEqual([
      {
        kind: 'mismatch',
        bookSlug: SLUG,
        mismatches: [{ phase: 'second-read', legacy: 'active', log: 'pending-completion' }],
      },
    ]);
  });

  it('a legacy error propagates and nothing is recorded', async () => {
    const { b, shadow, events } = await setup(6); // at Revision
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);
    await b.fs.deleteFile(SLUG, 'source/reader-report.md');
    const before = (await events()).lastSeq;

    await expect(shadow.completeRevision(SLUG)).rejects.toThrow(/reader-report\.md does not exist/);
    expect((await events()).lastSeq).toBe(before);
  });

  it('when pipeline-state.json changed under the log, an action is not mirrored and the next detection re-migrates', async () => {
    const { b, shadow, reports, events } = await setup(4, 'pending');
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);
    const firstEpoch = await events();

    // An older build confirms First Assessment, then this build confirms the plan
    await b.legacy.confirmPhaseAdvancement(SLUG, 'first-assessment');
    await legacyWork(b, 'revision-plan-1');
    await shadow.confirmPhaseAdvancement(SLUG, 'revision-plan-1');
    expect((await events()).lastSeq).toBe(firstEpoch.lastSeq);

    await shadow.detectPhases(SLUG);
    const log = await events();
    expect(reports.map((r) => r.kind)).toEqual(['migrated', 'remigrated']);
    expect(currentRun(log)?.legacyPhase).toBe('revision');
    // Run IDs continue after the first epoch
    expect(log.runs[0].id).toBe('r16');
    expect(reports.filter((r) => r.kind === 'mismatch')).toEqual([]);
  });

  it('reports a mismatch once while it lasts', async () => {
    const { b, shadow, reports } = await setup(7); // Second Read, report == newest archive
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG);

    // #87's bug: a new report with the same word count. Today's pipeline misses it.
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(70, 'same-length'));
    await shadow.detectPhases(SLUG);
    await shadow.detectPhases(SLUG);

    const mismatch = {
      kind: 'mismatch',
      bookSlug: SLUG,
      mismatches: [{ phase: 'second-read', legacy: 'active', log: 'pending-completion' }],
    };
    expect(reports.filter((r) => r.kind === 'mismatch')).toEqual([mismatch]);

    // Resolved, then back: reported again
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(90, 'longer'));
    await shadow.detectPhases(SLUG);
    await b.fs.writeFile(SLUG, 'source/reader-report.md', text(70, 'same-length-again'));
    await shadow.detectPhases(SLUG);
    expect(reports.filter((r) => r.kind === 'mismatch')).toEqual([mismatch, mismatch]);
  });

  it('shadow errors never fail a call; each error is reported once until it clears', async () => {
    const { b } = await setup(2);
    const reports: ShadowReport[] = [];
    let failing = true;
    const real = new RunLogService(b.fs);
    const flaky: IRunLogService = new Proxy(real, {
      get(target, key, receiver) {
        if (key === 'load') {
          return async (slug: string) => {
            if (failing) throw new Error('disk on fire');
            return target.load(slug);
          };
        }
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const shadow = new ShadowPipelineService(b.legacy, flaky, (r) => reports.push(r));
    shadow.openBook(SLUG);

    const phases: PipelinePhase[] = await shadow.detectPhases(SLUG);
    await shadow.detectPhases(SLUG);
    expect(phases).toEqual(await b.legacy.detectPhases(SLUG));
    expect(reports).toEqual([{ kind: 'error', bookSlug: SLUG, during: 'detect', message: 'disk on fire' }]);

    failing = false;
    await shadow.detectPhases(SLUG);
    failing = true;
    await shadow.detectPhases(SLUG);
    expect(reports.filter((r) => r.kind === 'error')).toHaveLength(2);
  });

  it('an appended event about a run the log doesn’t know is reported and ignored', async () => {
    const { b, shadow, reports } = await setup(4, 'pending');
    shadow.openBook(SLUG);
    await shadow.detectPhases(SLUG); // 21 lines: migrated, 15 planned, 4 done, 1 started
    const file = path.join(b.dir, RUN_LOG_FILE);
    await writeFile(file, (await readFile(file, 'utf-8')) + '{"v":1,"seq":999,"at":"x","e":"done","run":"r42","outputs":[]}\n');

    await shadow.detectPhases(SLUG);
    expect(reports.filter((r) => r.kind === 'issues')).toEqual([
      { kind: 'issues', bookSlug: SLUG, issues: [{ line: 22, reason: 'unknown run r42' }] },
    ]);
    expect(reports.filter((r) => r.kind === 'mismatch')).toEqual([]);
  });
});
