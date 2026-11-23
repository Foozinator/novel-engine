// THROWAWAY — spike #56 (iteration model). Test fixtures only; not for merge.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_PHASES } from '@domain/constants';
import type { IFileSystemService } from '@domain/interfaces';
import type { PipelinePhaseId } from '@domain/types';
import { makeLibrary, seedBook } from '../../test/bookFixtures';
import { makeTempDir } from '../../test/tempDir';
import { DEV_REPORT, READER_REPORT, archiveGroup, archivePlan } from '../archives';
import { PipelineService } from '../PipelineService';
import { outputsOf, PHASE_TYPES, type PhaseType } from './model';

export const SLUG = 'fixture';

/** `n` distinct words tagged with `tag`, so every output's content (and origin) is recognizable. */
export const text = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `${tag}:${i % 9}`).join(' ');

export type Book = { fs: IFileSystemService; dir: string; legacy: PipelineService };

export async function freshBook(): Promise<Book> {
  const lib = await makeLibrary(await makeTempDir());
  await seedBook(lib, SLUG, { title: 'Fixture', status: 'scaffolded' });
  const legacy = new PipelineService(lib.service);
  // Opening a book in today's app writes pipeline-state.json ({ confirmedPhases: [] }).
  await legacy.detectPhases(SLUG);
  return { fs: lib.service, dir: path.join(lib.booksDir, SLUG), legacy };
}

/**
 * What an agent (or the orchestrator, or the author) does during a legacy
 * phase, as the code does it today: the orchestrator archives earlier
 * reports (copy) and plans (move) before an agent writes (#81).
 */
export async function legacyWork(b: Book, phase: PipelinePhaseId, take = 1): Promise<void> {
  const w = (p: string, c: string) => b.fs.writeFile(SLUG, p, c);
  const tag = `${phase}#${take}`;
  switch (phase) {
    case 'pitch':
      return w('source/pitch.md', text(60, tag));
    case 'scaffold':
      return w('source/scene-outline.md', text(250, tag));
    case 'first-draft':
      await w('chapters/01-one/draft.md', text(700, `${tag}/one`));
      await w('chapters/02-two/draft.md', text(700, `${tag}/two`));
      await b.fs.updateBookMeta(SLUG, { status: 'revision-1' });
      return;
    case 'first-read':
    case 'second-read':
      await archiveGroup(b.fs, SLUG, [READER_REPORT], 'copy');
      return w(READER_REPORT, text(phase === 'first-read' ? 70 : 85, tag));
    case 'first-assessment':
    case 'second-assessment':
      await archiveGroup(b.fs, SLUG, [DEV_REPORT], 'copy');
      return w(DEV_REPORT, text(phase === 'first-assessment' ? 70 : 85, tag));
    case 'revision-plan-1':
    case 'revision-plan-2':
      await archivePlan(b.fs, SLUG, 'move');
      await w('source/project-tasks.md', text(phase === 'revision-plan-1' ? 60 : 75, `${tag}/tasks`));
      await w('source/revision-prompts.md', text(phase === 'revision-plan-1' ? 60 : 75, `${tag}/prompts`));
      return;
    case 'revision':
      return w('chapters/01-one/draft.md', text(720, `${tag}/one`));
    case 'copy-edit':
      await archiveGroup(b.fs, SLUG, ['source/audit-report.md'], 'copy');
      return w('source/audit-report.md', text(60, tag));
    case 'mechanical-fixes':
      await w('chapters/02-two/draft.md', text(700, `${tag}/two`));
      await b.fs.updateBookMeta(SLUG, { status: 'copy-edit' });
      return;
    case 'build':
      return w(`dist/${SLUG}.md`, `# Fixture\n\n${text(1400, tag)}`);
    case 'publish':
      return w('source/metadata.md', text(60, tag));
    case 'query-agents':
      return w('source/query-tracker.md', text(60, tag));
  }
}

/** The author's confirmation in the legacy UI. */
export async function legacyConfirm(b: Book, phase: PipelinePhaseId): Promise<void> {
  if (phase === 'revision') return b.legacy.completeRevision(SLUG);
  if (phase === 'mechanical-fixes') return b.legacy.markPhaseComplete(SLUG, 'mechanical-fixes');
  return b.legacy.confirmPhaseAdvancement(SLUG, phase);
}

export type Variant = 'active' | 'pending' | 'complete';

/** A legacy book stopped at phase `k`: phases before it confirmed, phase k untouched or with its work done. */
export async function legacyBookAt(k: number, variant: Variant): Promise<Book> {
  const b = await freshBook();
  const n = variant === 'complete' ? PIPELINE_PHASES.length : k;
  for (let i = 0; i < n; i++) {
    await legacyWork(b, PIPELINE_PHASES[i].id);
    await legacyConfirm(b, PIPELINE_PHASES[i].id);
  }
  if (variant === 'pending') await legacyWork(b, PIPELINE_PHASES[k].id);
  return b;
}

/** What an agent does during a run in the new model: fresh, distinct output. */
export async function newWork(b: Book, phase: PhaseType, tag: string): Promise<void> {
  const w = (p: string, c: string) => b.fs.writeFile(SLUG, p, c);
  const outs = outputsOf(phase, SLUG);
  if (phase === 'draft' || phase === 'revision' || phase === 'mechanical-fixes') {
    await w('chapters/01-one/draft.md', text(700, `${tag}/one`));
    await w('chapters/02-two/draft.md', text(700, `${tag}/two`));
    return;
  }
  const minWords = PHASE_TYPES[phase].minWords ?? 50;
  for (const p of outs) await w(p, text(Math.max(minWords, 60), `${tag}${p}`));
}

/** Every file under the book folder → sha256 of its bytes. */
export async function tree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(path.relative(root, full), createHash('sha256').update(await readFile(full)).digest('hex'));
    }
  };
  await walk(root);
  return out;
}

export function diffTrees(before: Map<string, string>, after: Map<string, string>) {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}
