import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_PHASES } from '@domain/constants';
import type { IFileSystemService } from '@domain/interfaces';
import type { PipelinePhaseId } from '@domain/types';
import { DEV_REPORT, READER_REPORT, archiveGroup, archivePlan } from '@app/archives';
import type { IPipelineService } from '@domain/interfaces';
import { PipelineService } from '@app/PipelineService';
import { makeLibrary, seedBook } from './bookFixtures';
import { makeTempDir } from './tempDir';

/**
 * Legacy books for the run log's tests (#87): real FileSystemService,
 * PipelineService and archives in a temp dir, driven the way today's app
 * drives them.
 */

export const SLUG = 'fixture';

/** `n` words tagged with `tag`, so every output's origin is recognizable. */
export const text = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `${tag}:${i % 9}`).join(' ');

export type FixtureBook = { fs: IFileSystemService; dir: string; legacy: PipelineService };

export async function freshBook(): Promise<FixtureBook> {
  const lib = await makeLibrary(await makeTempDir());
  await seedBook(lib, SLUG, { title: 'Fixture', status: 'scaffolded' });
  const legacy = new PipelineService(lib.service);
  // Opening a book in today's app writes pipeline-state.json ({ confirmedPhases: [] }).
  await legacy.detectPhases(SLUG);
  return { fs: lib.service, dir: path.join(lib.booksDir, SLUG), legacy };
}

/**
 * What an agent, the orchestrator or the author does during a legacy
 * phase, as the code does it today: the orchestrator archives earlier
 * reports (copy) and plans (move) before an agent writes (#81).
 *
 * Report and plan lengths grow with `take`, so a retake never has the
 * same word count as the version it replaces (today's checks compare
 * word counts; see the #87 bug test).
 */
export async function legacyWork(b: FixtureBook, phase: PipelinePhaseId, take = 1): Promise<void> {
  const write = (p: string, c: string) => b.fs.writeFile(SLUG, p, c);
  const tag = `${phase}#${take}`;
  const grow = take - 1;
  switch (phase) {
    case 'pitch':
      return write('source/pitch.md', text(60, tag));
    case 'scaffold':
      return write('source/scene-outline.md', text(250, tag));
    case 'first-draft':
      await write('chapters/01-one/draft.md', text(700, `${tag}/one`));
      await write('chapters/02-two/draft.md', text(700, `${tag}/two`));
      return;
    case 'first-read':
    case 'second-read':
      await archiveGroup(b.fs, SLUG, [READER_REPORT], 'copy');
      return write(READER_REPORT, text((phase === 'first-read' ? 70 : 85) + grow, tag));
    case 'first-assessment':
    case 'second-assessment':
      await archiveGroup(b.fs, SLUG, [DEV_REPORT], 'copy');
      return write(DEV_REPORT, text((phase === 'first-assessment' ? 70 : 85) + grow, tag));
    case 'revision-plan-1':
    case 'revision-plan-2': {
      const n = (phase === 'revision-plan-1' ? 60 : 75) + grow;
      await archivePlan(b.fs, SLUG, 'move');
      await write('source/project-tasks.md', text(n, `${tag}/tasks`));
      await write('source/revision-prompts.md', text(n, `${tag}/prompts`));
      return;
    }
    case 'revision':
      return write('chapters/01-one/draft.md', text(720, `${tag}/one`));
    case 'copy-edit':
      await archiveGroup(b.fs, SLUG, ['source/audit-report.md'], 'copy');
      return write('source/audit-report.md', text(60, tag));
    case 'mechanical-fixes':
      return write('chapters/02-two/draft.md', text(710, `${tag}/two`));
    case 'build':
      return write(`dist/${SLUG}.md`, `# Fixture\n\n${text(1400, tag)}`);
    case 'publish':
      return write('source/metadata.md', text(60, tag));
    case 'query-agents':
      return write('source/query-tracker.md', text(60, tag));
  }
}

/** The author's confirmation in today's UI: Mark done for the draft and fixes, Complete Revision, else Advance. */
export async function legacyConfirm(
  pipeline: IPipelineService,
  phase: PipelinePhaseId,
): Promise<void> {
  if (phase === 'revision') return pipeline.completeRevision(SLUG);
  if (phase === 'first-draft' || phase === 'mechanical-fixes') {
    return pipeline.markPhaseComplete(SLUG, phase);
  }
  return pipeline.confirmPhaseAdvancement(SLUG, phase);
}

export type Variant = 'active' | 'pending' | 'complete';

/**
 * A legacy book stopped at phase `k`: earlier phases worked and confirmed;
 * phase k untouched ('active') or with its work done ('pending'). 'complete'
 * runs every phase.
 */
export async function legacyBookAt(k: number, variant: Variant): Promise<FixtureBook> {
  const b = await freshBook();
  const n = variant === 'complete' ? PIPELINE_PHASES.length : k;
  for (let i = 0; i < n; i++) {
    await legacyWork(b, PIPELINE_PHASES[i].id);
    await legacyConfirm(b.legacy, PIPELINE_PHASES[i].id);
  }
  if (variant === 'pending') await legacyWork(b, PIPELINE_PHASES[k].id);
  return b;
}

/** Every file under `root` → sha256 of its bytes. */
export async function tree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), createHash('sha256').update(await readFile(full)).digest('hex'));
    }
  };
  await walk(root);
  return out;
}

export function diffTrees(
  before: Map<string, string>,
  after: Map<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}
