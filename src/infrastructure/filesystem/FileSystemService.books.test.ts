import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemService } from './FileSystemService';
import { makeLibrary, seedBook, type Library } from '../../test/bookFixtures';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';

let lib: Library;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  lib = await makeLibrary(await makeTempDir());
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('createBook', () => {
  it('creates the full directory skeleton, about.json, and front-matter chapters', async () => {
    const meta = await lib.service.createBook('My Great Novel', 'Jo Author');

    expect(meta.slug).toBe('my-great-novel');
    expect(meta.status).toBe('scaffolded');

    const root = path.join(lib.booksDir, 'my-great-novel');
    for (const dir of ['source', 'chapters', 'assets', 'dist']) {
      expect((await stat(path.join(root, dir))).isDirectory()).toBe(true);
    }

    const about = JSON.parse(await readFile(path.join(root, 'about.json'), 'utf-8'));
    expect(about).toMatchObject({ title: 'My Great Novel', author: 'Jo Author', status: 'scaffolded' });

    // Copyright + dedication front matter written; no pipeline-gating source files
    const copyright = await readFile(path.join(root, 'chapters', '00-0-copyright', 'draft.md'), 'utf-8');
    expect(copyright).toContain('Copyright © ');
    expect(copyright).toContain('Jo Author');
    const dedication = await readFile(path.join(root, 'chapters', '00-1-dedication', 'draft.md'), 'utf-8');
    expect(dedication).toContain('# Dedication');
    expect(await lib.service.fileExists('my-great-novel', 'source/scene-outline.md')).toBe(false);
  });

  it('sets the new book as active', async () => {
    await lib.service.createBook('First');
    expect(await lib.service.getActiveBookSlug()).toBe('first');
  });

  it.each([
    ['Spaces  And   Gaps', 'spaces-and-gaps'],
    ['Punct!uation? Ma&rks.', 'punct-uation-ma-rks'],
    ['  --Trimmed--  ', 'trimmed'],
    ['Café Überall', 'caf-berall'], // non-ascii letters are dropped, not transliterated
  ])('slugifies %j → %j', async (title, slug) => {
    const meta = await lib.service.createBook(title);
    expect(meta.slug).toBe(slug);
  });

  it('refuses a duplicate title and leaves the existing book untouched (#79)', async () => {
    await lib.service.createBook('Twin', 'First Author');
    await lib.service.writeFile('twin', 'chapters/01-one/draft.md', 'existing prose');
    const aboutBefore = await readFile(path.join(lib.booksDir, 'twin', 'about.json'), 'utf-8');

    await expect(lib.service.createBook('Twin', 'Second Author')).rejects.toThrow(
      'A book titled "Twin" already exists. Choose another title.'
    );

    expect(await readFile(path.join(lib.booksDir, 'twin', 'about.json'), 'utf-8')).toBe(aboutBefore);
    expect(await lib.service.readFile('twin', 'chapters/01-one/draft.md')).toBe('existing prose');
  });

  it('refuses a folder that appeared after the title check (EEXIST backstop)', async () => {
    const spy = vi.spyOn(lib.service, 'findTitleConflict').mockResolvedValue(null);
    await seedBook(lib, 'late', { title: 'Late', chapters: { '01-one': 'kept' } });

    await expect(lib.service.createBook('Late')).rejects.toThrow('A book in folder "late" already exists.');
    expect(await lib.service.readFile('late', 'chapters/01-one/draft.md')).toBe('kept');
    spy.mockRestore();
  });

  it('creates the books folder when it does not exist yet', async () => {
    const fresh = new FileSystemService(path.join(lib.userDataDir, 'no-books-yet'), lib.userDataDir);
    const meta = await fresh.createBook('First Book');
    expect(meta.slug).toBe('first-book');
  });
});

describe('findTitleConflict', () => {
  it('returns null for a free title, an empty library, or a title with no letters or digits', async () => {
    expect(await lib.service.findTitleConflict('Anything')).toBeNull();
    await seedBook(lib, 'alpha', { title: 'Alpha' });
    expect(await lib.service.findTitleConflict('Beta')).toBeNull();
    expect(await lib.service.findTitleConflict('!!!')).toBeNull();
  });

  it('matches a live book by title in any case or punctuation', async () => {
    await seedBook(lib, 'the-hollow-crown', { title: 'The Hollow Crown' });
    for (const title of ['The Hollow Crown', 'the hollow crown', 'The Hollow-Crown!', '  THE  HOLLOW  CROWN  ']) {
      expect(await lib.service.findTitleConflict(title)).toEqual({
        slug: 'the-hollow-crown',
        title: 'The Hollow Crown',
        archived: false,
      });
    }
  });

  it('matches a folder whose name differs in case, and a title whose folder name drifted', async () => {
    await seedBook(lib, 'Odd-Folder', { title: 'Something Else' });
    await seedBook(lib, 'old-name', { title: 'Renamed By Hand' });

    expect(await lib.service.findTitleConflict('Odd Folder')).toEqual({
      slug: 'Odd-Folder',
      title: 'Something Else',
      archived: false,
    });
    expect(await lib.service.findTitleConflict('renamed by hand')).toEqual({
      slug: 'old-name',
      title: 'Renamed By Hand',
      archived: false,
    });
  });

  it('matches a folder without a readable about.json by its name', async () => {
    await seedBook(lib, 'no-about', { omitAbout: true });
    await seedBook(lib, 'bad-about', { rawAbout: '{not json' });

    expect(await lib.service.findTitleConflict('No About')).toEqual({ slug: 'no-about', title: '', archived: false });
    expect(await lib.service.findTitleConflict('Bad About')).toEqual({ slug: 'bad-about', title: '', archived: false });
  });

  it('matches archived books, and ignores reserved folders', async () => {
    await seedBook(lib, 'ghost', { title: 'Ghost' });
    await lib.service.archiveBook('ghost');
    await seedBook(lib, '_pitches', { title: 'Pitches' });

    expect(await lib.service.findTitleConflict('GHOST')).toEqual({ slug: 'ghost', title: 'Ghost', archived: true });
    expect(await lib.service.findTitleConflict('Pitches')).toBeNull();
  });
});

describe('listBooks', () => {
  it('lists books sorted by title with word counts and the active flag', async () => {
    await seedBook(lib, 'zebra', { title: 'Zebra', chapters: { '01-one': 'one two three' } });
    await seedBook(lib, 'apple', { title: 'Apple' });
    await lib.service.setActiveBook('zebra');

    const books = await lib.service.listBooks();

    expect(books.map((b) => b.title)).toEqual(['Apple', 'Zebra']);
    const zebra = books[1];
    expect(zebra.wordCount).toBe(3);
    expect(zebra.isActive).toBe(true);
    expect(books[0].isActive).toBe(false);
  });

  it('ignores underscore/dot directories and skips books with malformed about.json', async () => {
    await seedBook(lib, 'good', { title: 'Good' });
    await seedBook(lib, 'broken', { rawAbout: '{not json' });
    await seedBook(lib, '_archived/old-book', { title: 'Old' });
    await seedBook(lib, '.hidden', { title: 'Hidden' });

    const books = await lib.service.listBooks();
    expect(books.map((b) => b.slug)).toEqual(['good']);
  });

  it('auto-imports a directory without about.json, humanizing the title', async () => {
    await seedBook(lib, 'my-imported-novel', { omitAbout: true });

    const books = await lib.service.listBooks();
    expect(books.length).toBe(1);
    expect(books[0].title).toBe('My Imported Novel');

    // Stub about.json was written — the import is idempotent
    const about = JSON.parse(
      await readFile(path.join(lib.booksDir, 'my-imported-novel', 'about.json'), 'utf-8')
    );
    expect(about.title).toBe('My Imported Novel');
  });

  it('returns [] when the books directory does not exist', async () => {
    const service = new FileSystemService(path.join(lib.userDataDir, 'nonexistent'), lib.userDataDir);
    expect(await service.listBooks()).toEqual([]);
  });
});

describe('active book', () => {
  it('round-trips through active-book.json and defaults to empty', async () => {
    expect(await lib.service.getActiveBookSlug()).toBe('');

    await lib.service.setActiveBook('some-book');
    expect(await lib.service.getActiveBookSlug()).toBe('some-book');
  });

  it('accepts a nonexistent slug without validation', async () => {
    await lib.service.setActiveBook('ghost-book');
    expect(await lib.service.getActiveBookSlug()).toBe('ghost-book');
  });
});

describe('getBookMeta', () => {
  it('throws a descriptive error for a missing book', async () => {
    await expect(lib.service.getBookMeta('nope')).rejects.toThrow(/Book "nope" not found/);
  });

  it('throws for malformed about.json', async () => {
    await seedBook(lib, 'bad', { rawAbout: 'not json at all' });
    await expect(lib.service.getBookMeta('bad')).rejects.toThrow(/malformed about\.json/);
  });
});

describe('updateBookMeta', () => {
  it('updates fields in place when the title (and slug) is unchanged', async () => {
    await lib.service.createBook('Stable Title');
    const updated = await lib.service.updateBookMeta('stable-title', { status: 'first-draft', author: 'New Author' });

    expect(updated.status).toBe('first-draft');
    expect(updated.author).toBe('New Author');
    expect(updated.slug).toBe('stable-title');
  });

  it('ignores unknown keys', async () => {
    await lib.service.createBook('Guarded');
    await lib.service.updateBookMeta('guarded', { rogue: 'value' } as never);

    const about = JSON.parse(await readFile(path.join(lib.booksDir, 'guarded', 'about.json'), 'utf-8'));
    expect(about).not.toHaveProperty('rogue');
  });

  it('renames the directory when the title changes the slug and follows the active book', async () => {
    await lib.service.createBook('Old Name'); // becomes active
    const updated = await lib.service.updateBookMeta('old-name', { title: 'New Name' });

    expect(updated.slug).toBe('new-name');
    expect((await stat(path.join(lib.booksDir, 'new-name'))).isDirectory()).toBe(true);
    await expect(stat(path.join(lib.booksDir, 'old-name'))).rejects.toThrow();
    expect(await lib.service.getActiveBookSlug()).toBe('new-name');
  });

  it('refuses to rename onto an existing book', async () => {
    await lib.service.createBook('Alpha');
    await lib.service.createBook('Beta');

    await expect(lib.service.updateBookMeta('beta', { title: 'Alpha' })).rejects.toThrow(
      /already exists/
    );
  });

  it('refuses to rename onto an archived book and leaves both books in place (#79)', async () => {
    await seedBook(lib, 'ghost', { title: 'Ghost' });
    await lib.service.archiveBook('ghost');
    await seedBook(lib, 'beta', { title: 'Beta' });

    await expect(lib.service.updateBookMeta('beta', { title: 'ghost!' })).rejects.toThrow(
      'Cannot rename book: An archived book titled "Ghost" already exists.'
    );
    expect((await lib.service.getBookMeta('beta')).title).toBe('Beta');
  });

  it('renames a folder whose name differs from its slug only in case', async () => {
    await seedBook(lib, 'Mixed-Case', { title: 'Mixed Case' });

    const updated = await lib.service.updateBookMeta('Mixed-Case', { title: 'Mixed Case' });

    expect(updated.slug).toBe('mixed-case');
    expect((await lib.service.getBookMeta('mixed-case')).title).toBe('Mixed Case');
  });
});

describe('reconcileBookSlugs', () => {
  it('renames folders whose about.json title drifted and reports the migrations', async () => {
    await lib.service.createBook('Original'); // active
    // Simulate an external edit to about.json
    const aboutPath = path.join(lib.booksDir, 'original', 'about.json');
    const about = JSON.parse(await readFile(aboutPath, 'utf-8'));
    about.title = 'Renamed Externally';
    await writeFile(aboutPath, JSON.stringify(about), 'utf-8');

    const migrations = await lib.service.reconcileBookSlugs();

    expect(migrations).toEqual([{ oldSlug: 'original', newSlug: 'renamed-externally' }]);
    expect((await stat(path.join(lib.booksDir, 'renamed-externally'))).isDirectory()).toBe(true);
    expect(await lib.service.getActiveBookSlug()).toBe('renamed-externally');
  });

  it('skips renames that would collide with an existing directory', async () => {
    await seedBook(lib, 'taken', { title: 'Taken' });
    await seedBook(lib, 'drifted', { title: 'Taken' }); // same title → same target slug

    const migrations = await lib.service.reconcileBookSlugs();

    expect(migrations).toEqual([]);
    expect((await stat(path.join(lib.booksDir, 'drifted'))).isDirectory()).toBe(true);
  });

  it('returns [] when nothing drifted', async () => {
    await lib.service.createBook('Consistent');
    expect(await lib.service.reconcileBookSlugs()).toEqual([]);
  });
});
