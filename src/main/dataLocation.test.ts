import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR_ENV,
  classifyFolder,
  needsFirstLaunchChoice,
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
  it('reports a missing or empty folder as empty, ignoring the pointer and OS clutter', async () => {
    expect(classifyFolder(path.join(other, 'missing'))).toBe('empty');
    await writeFile(path.join(other, '.DS_Store'), '');
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

describe('needsFirstLaunchChoice', () => {
  it('asks once when the default folder already holds data and no pointer exists', async () => {
    await writeFile(path.join(defaultDir, '.initialized'), 'x');
    expect(needsFirstLaunchChoice(defaultDir, resolve())).toBe(true);

    writePointer(defaultDir, null);
    expect(needsFirstLaunchChoice(defaultDir, resolve())).toBe(false);
  });

  it('does not ask on a fresh install or when overridden', async () => {
    expect(needsFirstLaunchChoice(defaultDir, resolve())).toBe(false);
    await writeFile(path.join(defaultDir, '.initialized'), 'x');
    expect(needsFirstLaunchChoice(defaultDir, resolve([`--data-dir=${other}`]))).toBe(false);
  });
});
