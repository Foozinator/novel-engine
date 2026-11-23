import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLibrary, seedBook, type Library } from '../../test/bookFixtures';
import { BINARY_FIXTURES } from '../../test/fixtures/binaryFiles';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';

let lib: Library;

/** Write raw bytes into the book, bypassing the service under test. */
async function seedBytes(relativePath: string, bytes: Buffer): Promise<string> {
  const abs = path.join(lib.booksDir, 'book', relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}

beforeEach(async () => {
  lib = await makeLibrary(await makeTempDir());
  await seedBook(lib, 'book', { title: 'Book' });
});

afterEach(async () => {
  await cleanupTempDirs();
});

describe('writeFile over binary files (#83)', () => {
  it.each(BINARY_FIXTURES)('refuses an edited text round trip of $path and leaves it unchanged', async ({ path: rel, bytes }) => {
    const abs = await seedBytes(rel, bytes);

    // What the editor did before the fix: read as UTF-8, change one character, save.
    const asText = await lib.service.readFile('book', rel);
    await expect(lib.service.writeFile('book', rel, `${asText}x`)).rejects.toThrow(
      `Not a text file: ${rel} in book "book" was left unchanged`,
    );
    // An unchanged round trip is refused too: UTF-8 decoding alone loses bytes.
    await expect(lib.service.writeFile('book', rel, asText)).rejects.toThrow(/Not a text file/);

    expect((await readFile(abs)).equals(bytes)).toBe(true);
  });

  it('refuses a binary file whose name claims nothing, judging by its bytes', async () => {
    const [png] = BINARY_FIXTURES;
    const abs = await seedBytes('assets/cover', png.bytes);

    await expect(lib.service.writeFile('book', 'assets/cover', 'text')).rejects.toThrow(/Not a text file/);
    expect((await readFile(abs)).equals(png.bytes)).toBe(true);
  });

  it('refuses bytes that are not valid UTF-8 even without a NUL', async () => {
    const bytes = Buffer.from([0x47, 0x49, 0x46, 0xff, 0xfe, 0x80, 0x81]);
    const abs = await seedBytes('assets/odd.bin', bytes);

    await expect(lib.service.writeFile('book', 'assets/odd.bin', 'text')).rejects.toThrow(/Not a text file/);
    expect((await readFile(abs)).equals(bytes)).toBe(true);
  });

  it('still overwrites a text file with an unlisted extension', async () => {
    await seedBytes('source/outline.org', Buffer.from('* Act one\n', 'utf-8'));

    await lib.service.writeFile('book', 'source/outline.org', '* Act one\n* Act two\n');
    expect(await lib.service.readFile('book', 'source/outline.org')).toBe('* Act one\n* Act two\n');
  });

  it('does not misjudge a long UTF-8 file whose sniffed sample ends mid-character', async () => {
    // 8191 ASCII bytes, then a 3-byte character straddling the 8192-byte sample.
    const text = `${'a'.repeat(8191)}€ and more`;
    await seedBytes('source/long.org', Buffer.from(text, 'utf-8'));

    await lib.service.writeFile('book', 'source/long.org', 'replaced');
    expect(await lib.service.readFile('book', 'source/long.org')).toBe('replaced');
  });

  it('creates a new file at a non-text path, since nothing is overwritten', async () => {
    await lib.service.writeFile('book', 'assets/new.png', 'placeholder');
    expect(await lib.service.readFile('book', 'assets/new.png')).toBe('placeholder');
  });

  it('writes known text types without sniffing their contents', async () => {
    // A .md file that happens to hold a NUL is still the author's text file.
    await seedBytes('source/odd.md', Buffer.from('a\0b', 'utf-8'));

    await lib.service.writeFile('book', 'source/odd.md', 'clean');
    expect(await lib.service.readFile('book', 'source/odd.md')).toBe('clean');
  });
});

describe('listDirectory file sizes', () => {
  it('reports byte sizes for files and none for directories', async () => {
    const [png] = BINARY_FIXTURES;
    await seedBytes(png.path, png.bytes);

    const tree = await lib.service.listDirectory('book');
    const assets = tree.find((e) => e.name === 'assets');
    expect(assets?.isDirectory).toBe(true);
    expect(assets?.size).toBeUndefined();
    // Match by name: entry paths use the platform separator (`assets\cover.png` on Windows).
    const cover = assets?.children?.find((e) => e.name === path.basename(png.path));
    expect(cover?.size).toBe(png.bytes.length);
  });
});
