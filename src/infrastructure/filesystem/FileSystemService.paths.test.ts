import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLibrary, seedBook, type Library } from '../../test/bookFixtures';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';

let lib: Library;
let outsideFile: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  lib = await makeLibrary(await makeTempDir());
  outsideFile = path.join(lib.userDataDir, 'outside.txt');
  await writeFile(outsideFile, 'outside', 'utf-8');
  await seedBook(lib, 'my-book', { files: { 'notes.md': 'in book' } });
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('book file operations stay inside the book', () => {
  it('reads and writes in-book paths as before', async () => {
    expect(await lib.service.readFile('my-book', 'notes.md')).toBe('in book');
    await lib.service.writeFile('my-book', 'chapters/01-one/draft.md', 'Chapter one.');
    expect(await readFile(path.join(lib.booksDir, 'my-book', 'chapters', '01-one', 'draft.md'), 'utf-8'))
      .toBe('Chapter one.');
  });

  it('refuses relative paths that leave the book', async () => {
    await expect(lib.service.readFile('my-book', '../../outside.txt')).rejects.toThrow(/outside book/);
    await expect(lib.service.writeFile('my-book', '../../outside.txt', 'x')).rejects.toThrow(/outside book/);
    await expect(lib.service.appendFile('my-book', '../../outside.txt', 'x')).rejects.toThrow(/outside book/);
    await expect(lib.service.deletePath('my-book', '../..')).rejects.toThrow(/outside book/);
    await expect(lib.service.fileExists('my-book', '../../outside.txt')).rejects.toThrow(/outside book/);
    await expect(lib.service.renameFile('my-book', 'notes.md', '../../moved.md')).rejects.toThrow(/outside book/);
    await expect(lib.service.listDirectory('my-book', '../..')).rejects.toThrow(/outside book/);
    expect(await readFile(outsideFile, 'utf-8')).toBe('outside');
  });

  it('refuses slugs that are not a single folder name', async () => {
    for (const slug of ['..', '../..', lib.userDataDir, 'my-book/..']) {
      await expect(lib.service.readFile(slug, 'outside.txt'), slug).rejects.toThrow(/Invalid book slug/);
      await expect(lib.service.writeFile(slug, 'x.md', 'x'), slug).rejects.toThrow(/Invalid book slug/);
    }
    expect(() => lib.service.getAbsolutePath(lib.userDataDir, 'outside.txt')).toThrow(/Invalid book slug/);
  });

  it('listDirectory gives nested entry paths with / separators on every platform', async () => {
    await lib.service.writeFile('my-book', 'chapters/01-one/draft.md', 'Chapter one.');

    const top = await lib.service.listDirectory('my-book');
    const chapters = top.find((e) => e.name === 'chapters');
    const chapter = chapters?.children?.find((e) => e.name === '01-one');
    expect(chapter?.path).toBe('chapters/01-one');
    expect(chapter?.children?.map((e) => e.path)).toEqual(['chapters/01-one/draft.md']);

    const sub = await lib.service.listDirectory('my-book', 'chapters/01-one');
    expect(sub.map((e) => e.path)).toEqual(['chapters/01-one/draft.md']);
  });

  it('getAbsolutePath resolves in-book paths only', () => {
    expect(lib.service.getAbsolutePath('my-book', 'dist')).toBe(path.join(lib.booksDir, 'my-book', 'dist'));
    expect(() => lib.service.getAbsolutePath('my-book', '../../outside.txt')).toThrow(/outside book/);
  });
});

describe('covers', () => {
  it('treats a cover path outside the book as no cover', async () => {
    await writeFile(
      path.join(lib.booksDir, 'my-book', 'about.json'),
      JSON.stringify({ title: 'My Book', author: '', status: 'scaffolded', created: '2026-01-01T00:00:00.000Z', coverImage: '../../outside.txt' }),
      'utf-8',
    );
    expect(await lib.service.getCoverImageAbsolutePath('my-book')).toBeNull();
  });
});

describe('pitch and draft IDs', () => {
  it('refuses IDs that are not a single path segment', async () => {
    await expect(lib.service.readShelvedPitch('../../outside')).rejects.toThrow(/Invalid pitch slug/);
    await expect(lib.service.deleteShelvedPitch('../x')).rejects.toThrow(/Invalid pitch slug/);
    expect(() => lib.service.getPitchDraftPath('../../x')).toThrow(/Invalid draft ID/);
    await expect(lib.service.deletePitchDraft('../..')).rejects.toThrow(/Invalid draft ID/);
  });
});

describe('unarchiveBook', () => {
  it('removes a .claude folder from the restored book', async () => {
    await lib.service.archiveBook('my-book');
    const archivedClaude = path.join(lib.booksDir, '_archived', 'my-book', '.claude');
    await mkdir(archivedClaude, { recursive: true });
    await writeFile(path.join(archivedClaude, 'settings.json'), '{"hooks":{}}', 'utf-8');

    await lib.service.unarchiveBook('my-book');

    await expect(stat(path.join(lib.booksDir, 'my-book', '.claude'))).rejects.toThrow();
    expect(await lib.service.readFile('my-book', 'notes.md')).toBe('in book');
  });
});
