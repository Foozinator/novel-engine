import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR_ENV,
  classifyFolder,
  copyAppData,
  needsLegacyImport,
  readPointer,
  resolveDataDir,
  writePointer,
} from './dataLocation';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';

let defaultDir: string;
let other: string;

beforeEach(async () => {
  defaultDir = await makeTempDir();
  other = await makeTempDir();
});

afterEach(async () => {
  await cleanupTempDirs();
});

const resolve = (argv: string[] = [], env: Record<string, string> = {}) =>
  resolveDataDir({ defaultDir, argv, env });

describe('resolveDataDir', () => {
  it('uses the default folder when nothing points elsewhere', () => {
    expect(resolve()).toEqual({ dir: defaultDir, source: 'default', confirmed: false });
  });

  it('follows the pointer file', () => {
    writePointer(defaultDir, other);
    expect(resolve()).toEqual({ dir: other, source: 'pointer', confirmed: true });
  });

  it('treats a pointer to null as the default, but confirmed', () => {
    writePointer(defaultDir, null);
    expect(resolve()).toEqual({ dir: defaultDir, source: 'default', confirmed: true });
  });

  it('lets env override the pointer, and the flag override env', async () => {
    const fromEnv = path.join(other, 'env');
    const fromFlag = path.join(other, 'flag');
    writePointer(defaultDir, path.join(other, 'pointer'));

    expect(resolve([], { [DATA_DIR_ENV]: fromEnv })).toMatchObject({ dir: fromEnv, source: 'env' });
    expect(resolve([`--data-dir=${fromFlag}`], { [DATA_DIR_ENV]: fromEnv })).toMatchObject({
      dir: fromFlag,
      source: 'flag',
    });
  });

  it('creates a missing target folder', async () => {
    const fresh = path.join(other, 'a', 'b');
    expect(resolve([`--data-dir=${fresh}`])).toMatchObject({ dir: fresh, source: 'flag' });
    expect(await readdir(fresh)).toEqual([]); // write probe cleaned up
  });

  it('rejects a relative path and falls back to the default', () => {
    const r = resolve(['--data-dir=relative/dir']);
    expect(r.dir).toBe(defaultDir);
    expect(r.source).toBe('flag');
    expect(r.problem).toMatch(/absolute/);
  });

  it('rejects a path that is a file', async () => {
    const file = path.join(other, 'file.txt');
    await writeFile(file, 'x');
    const r = resolve([`--data-dir=${file}`]);
    expect(r.problem).toMatch(/Not a folder/);
    expect(r.requested).toBe(file);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects an unwritable folder', async () => {
    const locked = path.join(other, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      expect(resolve([`--data-dir=${locked}`]).problem).toMatch(/not writable/);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('reports a malformed pointer instead of throwing', async () => {
    await writeFile(path.join(defaultDir, 'data-location.json'), '{nope');
    const r = resolve();
    expect(r.dir).toBe(defaultDir);
    expect(r.source).toBe('pointer');
    expect(r.problem).toMatch(/could not be read/);
  });

  it('ignores a malformed pointer when an override is given', async () => {
    await writeFile(path.join(defaultDir, 'data-location.json'), '{nope');
    expect(resolve([`--data-dir=${other}`])).toMatchObject({ dir: other, source: 'flag' });
  });
});

describe('writePointer / readPointer', () => {
  it('round-trips and leaves no temp file behind', async () => {
    writePointer(defaultDir, other);
    expect(readPointer(defaultDir)).toEqual({ dataDir: other, confirmed: true });
    expect(await readdir(defaultDir)).toEqual(['data-location.json']);
    expect(JSON.parse(await readFile(path.join(defaultDir, 'data-location.json'), 'utf-8'))).toEqual({
      dataDir: other,
      confirmed: true,
    });
  });

  it('returns null when there is no pointer', () => {
    expect(readPointer(defaultDir)).toBeNull();
  });

  it('rejects a non-string dataDir', async () => {
    await writeFile(path.join(defaultDir, 'data-location.json'), '{"dataDir": 5}');
    expect(() => readPointer(defaultDir)).toThrow(/dataDir/);
  });
});

describe('classifyFolder', () => {
  it('reports a missing or empty folder as empty, ignoring the pointer, browser files and OS clutter', async () => {
    expect(classifyFolder(path.join(other, 'missing'))).toBe('empty');
    await writeFile(path.join(other, '.DS_Store'), '');
    await mkdir(path.join(other, 'Code Cache'));
    await writeFile(path.join(other, 'SingletonSocket'), '');
    await writeFile(path.join(other, 'data-location.json'), '{}');
    expect(classifyFolder(other)).toBe('empty');
  });

  it('recognises Novel Engine data', async () => {
    await writeFile(path.join(other, 'novel-engine.db'), '');
    expect(classifyFolder(other)).toBe('novel-engine');
  });

  it('flags unrelated content', async () => {
    await writeFile(path.join(other, 'taxes.xlsx'), '');
    expect(classifyFolder(other)).toBe('other');
  });
});

describe('needsLegacyImport', () => {
  // `other` plays the pre-rename "Novel Engine" folder here.
  it('offers once when only the legacy folder holds data', async () => {
    await writeFile(path.join(other, 'novel-engine.db'), '');
    await mkdir(path.join(defaultDir, 'GPUCache')); // Electron's own files don't count
    expect(needsLegacyImport(defaultDir, other, resolve())).toBe(true);

    writePointer(defaultDir, null);
    expect(needsLegacyImport(defaultDir, other, resolve())).toBe(false);
  });

  it('does not offer when Spur already has data, the legacy folder has none, or an override is set', async () => {
    expect(needsLegacyImport(defaultDir, other, resolve())).toBe(false); // no legacy data
    await writeFile(path.join(other, '.initialized'), 'x');
    expect(needsLegacyImport(defaultDir, other, resolve([`--data-dir=${path.join(other, 'x')}`]))).toBe(false);
    await writeFile(path.join(defaultDir, '.initialized'), 'x');
    expect(needsLegacyImport(defaultDir, other, resolve())).toBe(false);
  });

  it('never treats the default folder as its own legacy folder', async () => {
    await writeFile(path.join(defaultDir, '.initialized'), 'x');
    expect(needsLegacyImport(defaultDir, defaultDir, resolve())).toBe(false);
  });
});

describe('copyAppData', () => {
  it('copies app data, skips browser-profile files and the pointer, and keeps existing files', async () => {
    await mkdir(path.join(other, 'books', 'my-book'), { recursive: true });
    await writeFile(path.join(other, 'books', 'my-book', 'about.json'), '{}');
    await writeFile(path.join(other, 'novel-engine.db'), 'db');
    await writeFile(path.join(other, 'novel-engine.db-wal'), 'wal');
    await writeFile(path.join(other, 'settings.json'), '{"old":true}');
    await mkdir(path.join(other, 'Local Storage'));
    await mkdir(path.join(other, 'GPUCache'));
    await writeFile(path.join(other, 'SingletonLock'), '');
    await writeFile(path.join(other, 'data-location.json'), '{"dataDir":"/elsewhere"}');
    await writeFile(path.join(defaultDir, 'settings.json'), '{"spur":true}');

    const copied = await copyAppData(other, defaultDir);

    expect(copied.sort()).toEqual(['Local Storage', 'books', 'novel-engine.db', 'novel-engine.db-wal']);
    expect(await readFile(path.join(defaultDir, 'books', 'my-book', 'about.json'), 'utf-8')).toBe('{}');
    expect(await readFile(path.join(defaultDir, 'settings.json'), 'utf-8')).toBe('{"spur":true}');
    expect((await readdir(defaultDir)).sort()).toEqual([
      'Local Storage',
      'books',
      'novel-engine.db',
      'novel-engine.db-wal',
      'settings.json',
    ]);
    // Source untouched
    expect(await readFile(path.join(other, 'data-location.json'), 'utf-8')).toContain('/elsewhere');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'removes partial copies when a copy fails',
    async () => {
      await writeFile(path.join(other, 'a-first.md'), 'a');
      const unreadable = path.join(other, 'b-unreadable.md');
      await writeFile(unreadable, 'b');
      await chmod(unreadable, 0o000);
      try {
        await expect(copyAppData(other, defaultDir)).rejects.toThrow();
        expect(await readdir(defaultDir)).toEqual([]);
      } finally {
        await chmod(unreadable, 0o600);
      }
    },
  );
});
