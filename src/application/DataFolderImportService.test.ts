import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '@infra/database/DatabaseService';
import { makeSourceDataFolderOpener } from '@infra/database/SourceDataFolder';
import { SeriesService } from '@infra/series/SeriesService';
import type { DataFolderImportConfig } from '@domain/types';
import { DataFolderImportService } from './DataFolderImportService';
import { makeConversation, makeMessage, makeFileVersion } from '../test/db';
import { makeTempDir, cleanupTempDirs } from '../test/tempDir';
import { makeLibrary, seedBook, type Library } from '../test/bookFixtures';

const TEMPLATE = '# Author Profile\n\nDescribe yourself.\n';

async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return out;
}

let src: Library;
let dst: Library;
let tmpRoot: string;
let target: DatabaseService;
let series: SeriesService;
let service: DataFolderImportService;

/** Source data folder: two books with history, a pitch-room row, a series and a profile. */
async function seedSource(): Promise<void> {
  await seedBook(src, 'the-long-road', {
    title: 'The Long Road',
    author: 'A. Writer',
    chapters: { '00-0-copyright': 'front matter words', '01-start': 'one two three', '02-middle': 'four five' },
    files: { 'pipeline-state.json': '{"confirmedPhases":["pitch"]}', 'source/revision-queue-state.json': '{"conversationId":"lr-1"}' },
  });
  await seedBook(src, 'short-stories', { title: 'Short Stories', chapters: { '01-a': 'alpha' } });
  await seedBook(src, '_archived/old-thing', { title: 'Old' });

  const db = new DatabaseService(path.join(src.userDataDir, 'novel-engine.db'));
  const c = makeConversation(db, { id: 'lr-1', bookSlug: 'the-long-road' });
  makeMessage(db, c.id, { content: 'Draft chapter one' });
  makeFileVersion(db, { bookSlug: 'the-long-road', filePath: 'chapters/01-start/draft.md', content: 'one two three' });
  db.recordWordCountSnapshot('the-long-road', 5, 2);
  const s = makeConversation(db, { id: 'ss-1', bookSlug: 'short-stories' });
  makeMessage(db, s.id, { content: 'hi' });
  makeConversation(db, { id: 'pr-1', bookSlug: '__pitch-room__' });
  db.close();

  await mkdir(path.join(src.userDataDir, 'series', 'road-saga'), { recursive: true });
  await writeFile(
    path.join(src.userDataDir, 'series', 'road-saga', 'series.json'),
    JSON.stringify({
      slug: 'road-saga', name: 'Road Saga', description: '', created: 'x', updated: 'x',
      volumes: [{ bookSlug: 'the-long-road', volumeNumber: 1 }, { bookSlug: 'missing-book', volumeNumber: 2 }],
    }),
  );
  await writeFile(path.join(src.userDataDir, 'series', 'road-saga', 'series-bible.md'), '# Bible');
  await writeFile(path.join(src.userDataDir, 'author-profile.md'), 'I write long roads.');
}

function config(overrides: Partial<DataFolderImportConfig> = {}): DataFolderImportConfig {
  return {
    sourcePath: src.userDataDir,
    books: [
      { slug: 'the-long-road', action: 'import' },
      { slug: 'short-stories', action: 'import' },
    ],
    copyAuthorProfile: false,
    copySeries: false,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  src = await makeLibrary(await makeTempDir());
  dst = await makeLibrary(await makeTempDir());
  tmpRoot = await makeTempDir();
  target = new DatabaseService(path.join(dst.userDataDir, 'novel-engine.db'));
  series = new SeriesService(dst.userDataDir);
  await writeFile(path.join(dst.userDataDir, 'author-profile.md'), TEMPLATE);
  service = new DataFolderImportService(
    target,
    series,
    makeSourceDataFolderOpener(dst.userDataDir, tmpRoot),
    { userDataPath: dst.userDataDir, booksDir: dst.booksDir, tmpRoot },
    TEMPLATE,
  );
  await seedSource();
});

afterEach(async () => {
  target.close();
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe('DataFolderImportService.preview', () => {
  it('lists live books with sizes and leaves the source untouched', async () => {
    const before = await hashTree(src.userDataDir);
    const preview = await service.preview(src.userDataDir);

    expect(preview.books.map((b) => b.slug)).toEqual(['short-stories', 'the-long-road']);
    const road = preview.books.find((b) => b.slug === 'the-long-road')!;
    expect(road).toMatchObject({
      title: 'The Long Road',
      author: 'A. Writer',
      wordCount: 5,
      chapterCount: 2,
      conversationCount: 1,
      folderExists: false,
      alreadyImported: false,
    });
    expect(road.historyBytes).toBe('one two three'.length + 'Draft chapter one'.length);
    expect(preview.hasAuthorProfile).toBe(true);
    expect(preview.seriesSlugs).toEqual(['road-saga']);

    expect(await hashTree(src.userDataDir)).toEqual(before);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('flags folder clashes, including archived books', async () => {
    await seedBook(dst, 'the-long-road');
    await seedBook(dst, '_archived/short-stories');
    const preview = await service.preview(src.userDataDir);
    expect(preview.books.every((b) => b.folderExists)).toBe(true);
  });
});

describe('DataFolderImportService.commit', () => {
  it('imports folders and history, and the source is byte-for-byte unchanged', async () => {
    const before = await hashTree(src.userDataDir);
    const result = await service.commit(config());

    expect(result.skipped).toEqual([]);
    expect(result.imported.map((i) => i.to).sort()).toEqual(['short-stories', 'the-long-road']);

    const road = path.join(dst.booksDir, 'the-long-road');
    expect(await readFile(path.join(road, 'chapters', '01-start', 'draft.md'), 'utf-8')).toBe('one two three');
    expect(await readFile(path.join(road, 'pipeline-state.json'), 'utf-8')).toContain('pitch');
    expect(await readFile(path.join(road, 'source', 'revision-queue-state.json'), 'utf-8')).toContain('lr-1');
    expect(existsSync(path.join(road, '.novel-engine'))).toBe(false);

    expect(target.listConversations('the-long-road').map((c) => c.id)).toEqual(['lr-1']);
    expect(target.getMessages('lr-1')[0].content).toBe('Draft chapter one');
    expect(target.countFileVersions('the-long-road', 'chapters/01-start/draft.md')).toBe(1);
    expect(target.getWordCountHistory('the-long-road')).toHaveLength(1);
    expect(target.listConversations('__pitch-room__')).toEqual([]);

    expect((await dst.service.listBooks()).map((b) => b.slug).sort()).toEqual(['short-stories', 'the-long-road']);
    expect((await readdir(dst.booksDir)).filter((n) => n.startsWith('_importing'))).toEqual([]);
    expect(await hashTree(src.userDataDir)).toEqual(before);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('renames on a clash: new folder, new title, rows and series rewritten', async () => {
    await seedBook(dst, 'the-long-road', { title: 'Mine' });
    const result = await service.commit(
      config({
        books: [{ slug: 'the-long-road', action: 'rename', newTitle: 'The Long Road (old laptop)' }],
        copySeries: true,
      }),
    );

    expect(result.imported).toEqual([
      { from: 'the-long-road', to: 'the-long-road-old-laptop', title: 'The Long Road (old laptop)', conversations: 1, versions: 1 },
    ]);
    const about = JSON.parse(await readFile(path.join(dst.booksDir, 'the-long-road-old-laptop', 'about.json'), 'utf-8'));
    expect(about).toMatchObject({ title: 'The Long Road (old laptop)', author: 'A. Writer' });
    expect(JSON.parse(await readFile(path.join(dst.booksDir, 'the-long-road', 'about.json'), 'utf-8')).title).toBe('Mine');
    expect(target.listConversations('the-long-road-old-laptop')).toHaveLength(1);
    expect(target.listConversations('the-long-road')).toEqual([]);

    const saga = await series.getSeries('road-saga');
    expect(saga?.volumes).toEqual([{ bookSlug: 'the-long-road-old-laptop', volumeNumber: 1 }]);
    expect(await series.readSeriesBible('road-saga')).toBe('# Bible');
    expect((await series.getSeriesForBook('the-long-road-old-laptop'))?.slug).toBe('road-saga');
    expect(result.warnings.some((w) => w.includes('missing-book'))).toBe(true);
  });

  it('skips a clash with import, and a skip writes nothing', async () => {
    await seedBook(dst, 'the-long-road', { title: 'Mine' });
    const result = await service.commit(
      config({ books: [{ slug: 'the-long-road', action: 'import' }, { slug: 'short-stories', action: 'skip' }] }),
    );
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((s) => s.slug)).toEqual(['the-long-road', 'short-stories']);
    expect(result.skipped[0].reason).toMatch(/already exists/);
    expect(existsSync(path.join(dst.booksDir, 'short-stories'))).toBe(false);
    expect(target.listConversations('the-long-road')).toEqual([]);
  });

  it('detects a book that was already imported', async () => {
    await service.commit(config({ books: [{ slug: 'short-stories', action: 'import' }] }));
    const preview = await service.preview(src.userDataDir);
    expect(preview.books.find((b) => b.slug === 'short-stories')).toMatchObject({ folderExists: true, alreadyImported: true });

    const again = await service.commit(
      config({ books: [{ slug: 'short-stories', action: 'rename', newTitle: 'Short Stories 2' }] }),
    );
    expect(again.imported).toEqual([]);
    expect(again.skipped[0].reason).toMatch(/Already imported/);
  });

  it('ignores slugs that are not live books in the source', async () => {
    const result = await service.commit(
      config({ books: [{ slug: '../escape', action: 'import' }, { slug: '_archived', action: 'import' }] }),
    );
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['Not found in the source folder', 'Not found in the source folder']);
  });

  it('leaves neither rows nor a folder when installing fails', async () => {
    vi.spyOn(target, 'importBookHistory').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const result = await service.commit(config({ books: [{ slug: 'the-long-road', action: 'import' }] }));
    expect(result.skipped[0].reason).toBe('Failed: disk full');
    expect(await readdir(dst.booksDir)).toEqual([]);
    expect(target.listConversations('the-long-road')).toEqual([]);
  });

  it('reverts the merged rows when the final move fails', async () => {
    const real = target.importBookHistory.bind(target);
    vi.spyOn(target, 'importBookHistory').mockImplementationOnce((file, slug) => {
      const receipt = real(file, slug);
      // Simulate another writer creating the folder between merge and rename.
      mkdirSync(path.join(dst.booksDir, slug));
      return receipt;
    });
    const result = await service.commit(config({ books: [{ slug: 'the-long-road', action: 'import' }] }));
    expect(result.skipped[0].reason).toMatch(/appeared during import/);
    expect(target.listConversations('the-long-road')).toEqual([]);
    expect(target.countFileVersions('the-long-road', 'chapters/01-start/draft.md')).toBe(0);
    expect((await readdir(dst.booksDir)).filter((n) => n.startsWith('_importing'))).toEqual([]);
  });

  it('copies the author profile only over the template', async () => {
    await service.commit(config({ books: [{ slug: 'short-stories', action: 'import' }], copyAuthorProfile: true }));
    expect(await readFile(path.join(dst.userDataDir, 'author-profile.md'), 'utf-8')).toBe('I write long roads.');

    await writeFile(path.join(dst.userDataDir, 'author-profile.md'), 'My own profile.');
    const result = await service.commit(config({ books: [], copyAuthorProfile: true }));
    expect(await readFile(path.join(dst.userDataDir, 'author-profile.md'), 'utf-8')).toBe('My own profile.');
    expect(result.warnings[0]).toMatch(/author profile here was kept/);
  });

  it('does not overwrite an existing series', async () => {
    await series.createSeries('Road Saga');
    const result = await service.commit(config({ copySeries: true }));
    expect((await series.getSeries('road-saga'))?.volumes).toEqual([]);
    expect(result.warnings.some((w) => w.includes('already exists here'))).toBe(true);
  });
});
