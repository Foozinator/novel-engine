/**
 * #79: creating or importing a book whose title matches an existing book
 * must be refused by every caller, without changing a byte of the library.
 *
 * Runs the real FileSystemService, ManuscriptImportService, SeriesImportService
 * and SeriesService against a temp data folder and compares the whole folder
 * before and after each refused call.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedChapter } from '@domain/types';
import { PITCH_ROOM_SLUG } from '@domain/constants';
import { SeriesService } from '@infra/series/SeriesService';
import { ManuscriptImportService } from './ManuscriptImportService';
import { SeriesImportService } from './SeriesImportService';
import { makeLibrary, seedBook, type Library } from '../test/bookFixtures';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';

let lib: Library;
let manuscriptImport: ManuscriptImportService;
let seriesImport: SeriesImportService;

const CHAPTERS: DetectedChapter[] = [
  { index: 0, title: 'Opening', startLine: 0, endLine: 2, wordCount: 3, content: '# Opening\n\nNew draft text.' },
];

/** Every file and folder under `root`, keyed by relative path; file values are their bytes. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, '');
        await walk(full);
      } else {
        out.set(rel, (await readFile(full)).toString('base64'));
      }
    }
  };
  await walk(root);
  return out;
}

async function expectRefusedWithoutChanges(attempt: () => Promise<unknown>, message: RegExp): Promise<void> {
  const before = await snapshot(lib.userDataDir);
  await expect(attempt()).rejects.toThrow(message);
  expect(await snapshot(lib.userDataDir)).toEqual(before);
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  lib = await makeLibrary(await makeTempDir());
  manuscriptImport = new ManuscriptImportService(lib.service, '/unused/pandoc');
  seriesImport = new SeriesImportService(manuscriptImport, new SeriesService(lib.userDataDir), lib.service);

  // A live book well past scaffolding, with a cover and prose of its own
  await seedBook(lib, 'twin', {
    title: 'Twin',
    author: 'First Author',
    status: 'revision-1',
    chapters: { '01-opening': 'The original opening.', '02-middle': 'The original middle.' },
    files: { 'source/pitch.md': '# Twin\n\nThe first story.', 'cover.jpg': 'not really a jpeg' },
  });
  // An archived book
  await seedBook(lib, 'ghost', { title: 'Ghost', chapters: { '01-one': 'Archived prose.' } });
  await lib.service.archiveBook('ghost');
  await lib.service.setActiveBook('twin');
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe.each([
  ['the same title', 'Twin', /A book titled "Twin" already exists\. Choose another title\./],
  ['a title differing only in case and punctuation', 'TWIN!', /A book titled "Twin" already exists\. Titles that differ only in case or punctuation/],
  ['an archived book\'s title', 'Ghost', /An archived book titled "Ghost" already exists/],
])('%s', (_label, title, message) => {
  it('new book: createBook refuses', async () => {
    await expectRefusedWithoutChanges(() => lib.service.createBook(title, 'Someone'), message);
  });

  it('manuscript import: commit refuses before writing any chapter', async () => {
    await expectRefusedWithoutChanges(
      () => manuscriptImport.commit({ title, author: 'Someone', chapters: CHAPTERS }),
      message,
    );
  });

  it('series import: commit refuses the batch before creating the series or any volume', async () => {
    await expectRefusedWithoutChanges(
      () =>
        seriesImport.commit({
          seriesName: 'The Saga',
          existingSeriesSlug: null,
          author: 'Someone',
          volumes: [
            { volumeNumber: 1, title: 'A Fresh Volume', chapters: CHAPTERS },
            { volumeNumber: 2, title, chapters: CHAPTERS },
          ],
        }),
      message,
    );
  });

  it('pitch promotion: promotePitchToBook refuses and keeps the draft', async () => {
    const draftDir = path.join(lib.booksDir, PITCH_ROOM_SLUG, 'drafts', 'conv-1', 'source');
    await mkdir(draftDir, { recursive: true });
    await writeFile(path.join(draftDir, 'pitch.md'), `# ${title}\n\nA new idea.`, 'utf-8');

    await expectRefusedWithoutChanges(() => lib.service.promotePitchToBook('conv-1'), message);
  });

  it('shelved pitch: restorePitch refuses and keeps the pitch on the shelf', async () => {
    await mkdir(path.join(lib.booksDir, '_pitches'), { recursive: true });
    await writeFile(
      path.join(lib.booksDir, '_pitches', 'shelved.md'),
      `---\ntitle: ${title}\nshelvedAt: 2026-01-01T00:00:00.000Z\nshelvedFrom: \nlogline: idea\n---\n# ${title}\n`,
      'utf-8',
    );

    await expectRefusedWithoutChanges(() => lib.service.restorePitch('shelved'), message);
  });
});

describe('series import with repeated volume titles', () => {
  it('refuses the batch and names the repeated volume', async () => {
    await expectRefusedWithoutChanges(
      () =>
        seriesImport.commit({
          seriesName: 'The Saga',
          existingSeriesSlug: null,
          author: 'Someone',
          volumes: [
            { volumeNumber: 1, title: 'Book One', chapters: CHAPTERS },
            { volumeNumber: 2, title: 'Book one.', chapters: CHAPTERS },
          ],
        }),
      /Volume 2: Volume 1 has the same title/,
    );
  });
});

describe('choosing another title', () => {
  it('pitch promotion and restore accept a replacement title and leave the existing book alone', async () => {
    const twinBefore = await snapshot(path.join(lib.booksDir, 'twin'));

    const draftDir = path.join(lib.booksDir, PITCH_ROOM_SLUG, 'drafts', 'conv-1', 'source');
    await mkdir(draftDir, { recursive: true });
    await writeFile(path.join(draftDir, 'pitch.md'), '# Twin\n\nA new idea.', 'utf-8');
    const promoted = await lib.service.promotePitchToBook('conv-1', 'Twin, Second Draft');
    expect(promoted).toMatchObject({ slug: 'twin-second-draft', title: 'Twin, Second Draft' });
    expect(await lib.service.readFile('twin-second-draft', 'source/pitch.md')).toBe('# Twin\n\nA new idea.');

    await mkdir(path.join(lib.booksDir, '_pitches'), { recursive: true });
    await writeFile(path.join(lib.booksDir, '_pitches', 'ghost.md'), '---\ntitle: Ghost\n---\n# Ghost\n', 'utf-8');
    const restored = await lib.service.restorePitch('ghost', '  Ghost Returns  ');
    expect(restored).toMatchObject({ slug: 'ghost-returns', title: 'Ghost Returns' });

    expect(await snapshot(path.join(lib.booksDir, 'twin'))).toEqual(twinBefore);
  });
});
