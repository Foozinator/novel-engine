// THROWAWAY — spike #56. Runs only with SPIKE56_BOOKS=<books dir>; works on a temp COPY.
import { appendFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemService } from '@infra/filesystem/FileSystemService';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';
import { diffTrees, tree } from './fixtures';
import { legacyStatuses, migrateBook, projectLegacy } from './migrate';
import { RUN_LOG_PATH, currentRun } from './runLog';

const SOURCE = process.env.SPIKE56_BOOKS;
afterEach(cleanupTempDirs);

describe.skipIf(!SOURCE)('spike #56 — migrate copies of real dev books', () => {
  it('migrates every book, writing only the run log', async () => {
    const tmp = await makeTempDir();
    const books = path.join(tmp, 'books');
    await cp(SOURCE!, books, { recursive: true });
    const fs = new FileSystemService(books, tmp);
    const slugs = (await readdir(books, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const dir = path.join(books, slug);
      const before = await tree(dir);
      const legacy = await legacyStatuses(fs, slug);
      const result = await migrateBook(fs, slug);
      const diff = diffTrees(before, await tree(dir));
      const projected = await projectLegacy(fs, slug);
      const cur = currentRun(result.folded);
      if (process.env.SPIKE56_OUT) await appendFile(process.env.SPIKE56_OUT, `${slug}: ${result.outcome}; current = ${cur?.legacyPhase} (${cur && legacy[cur.legacyPhase!]}); done runs = ${result.folded.runs.filter((r) => r.state === 'done').length}; files added = ${diff.added.join(',')}\n`);
      expect(diff).toEqual({ added: [RUN_LOG_PATH], removed: [], changed: [] });
      expect(projected).toEqual(legacy);
    }
  });
});
