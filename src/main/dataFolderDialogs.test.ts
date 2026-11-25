import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseDataFolder, runStartupDataFolderChecks } from './dataFolderDialogs';
import { readPointer, resolveDataDir } from './dataLocation';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';
import { makeFakeHost, type FakeHost } from '../test/fakeHost';

let host: FakeHost;

let defaultDir: string;
let target: string;
/** A legacy folder that does not exist, for tests not about the legacy import. */
let noLegacy: string;

/** Queue message-box answers by button label, in call order. */
function answer(...labels: string[]): void {
  const queue = [...labels];
  host.confirm.mockImplementation(async (options: { buttons?: string[] }) => {
    const label = queue.shift();
    const response = label === undefined ? 0 : (options.buttons ?? []).indexOf(label);
    if (response < 0) throw new Error(`No button "${label}" in ${JSON.stringify(options.buttons)}`);
    return response;
  });
}

function pick(...dirs: (string | null)[]): void {
  for (const dir of dirs) {
    host.pickFiles.mockResolvedValueOnce(dir === null ? null : [dir]);
  }
}

const resolve = (argv: string[] = []) => resolveDataDir({ defaultDir, argv, env: {} });

beforeEach(async () => {
  host = makeFakeHost();
  defaultDir = await makeTempDir();
  target = await makeTempDir();
  noLegacy = path.join(target, 'no-legacy');
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('runStartupDataFolderChecks', () => {
  it('does nothing on a fresh install', async () => {
    await expect(runStartupDataFolderChecks(host, defaultDir, noLegacy, resolve())).resolves.toBe(false);
    expect(host.confirm).not.toHaveBeenCalled();
  });

  describe('first launch with data in the pre-rename folder', () => {
    let legacyDir: string;

    beforeEach(async () => {
      legacyDir = await makeTempDir();
      await mkdir(path.join(legacyDir, 'books', 'my-book'), { recursive: true });
      await writeFile(path.join(legacyDir, 'books', 'my-book', 'about.json'), '{}');
      await writeFile(path.join(legacyDir, 'novel-engine.db'), 'db');
    });

    it('copies the data into the default folder and continues without restarting', async () => {
      answer('Copy it here (recommended)');
      await expect(runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve())).resolves.toBe(false);
      expect(await readFile(path.join(defaultDir, 'novel-engine.db'), 'utf-8')).toBe('db');
      expect(await readFile(path.join(defaultDir, 'books', 'my-book', 'about.json'), 'utf-8')).toBe('{}');
      expect(readPointer(defaultDir)).toEqual({ dataDir: null, confirmed: true });
      expect(host.relaunch).not.toHaveBeenCalled();
      // Asked once: the next launch goes straight through
      expect(await runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve())).toBe(false);
      expect(host.confirm).toHaveBeenCalledTimes(1);
    });

    it('uses the old folder in place by pointing at it and relaunching', async () => {
      answer('Use the old folder in place');
      await expect(runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve())).resolves.toBe(true);
      expect(readPointer(defaultDir)).toEqual({ dataDir: legacyDir, confirmed: true });
      expect(host.relaunch).toHaveBeenCalled();
      expect(await readdir(defaultDir)).toEqual(['data-location.json']);
    });

    it('starts fresh without copying', async () => {
      answer('Start fresh');
      await expect(runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve())).resolves.toBe(false);
      expect(await readdir(defaultDir)).toEqual(['data-location.json']);
      expect(readPointer(defaultDir)).toEqual({ dataDir: null, confirmed: true });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'reports a failed copy, cleans up, and can start fresh instead',
      async () => {
        const unreadable = path.join(legacyDir, 'novel-engine.db');
        await chmod(unreadable, 0o000);
        try {
          answer('Copy it here (recommended)', 'Start fresh');
          await expect(runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve())).resolves.toBe(false);
          const error = host.confirm.mock.calls[1][0] as { type: string };
          expect(error.type).toBe('error');
          expect(await readdir(defaultDir)).toEqual(['data-location.json']);
        } finally {
          await chmod(unreadable, 0o600);
        }
      },
    );

    it('is not offered when an override is active', async () => {
      await expect(
        runStartupDataFolderChecks(host, defaultDir, legacyDir, resolve([`--data-dir=${target}`])),
      ).resolves.toBe(false);
      expect(host.confirm).not.toHaveBeenCalled();
    });
  });

  describe('unusable folder', () => {
    it('can fall back to the default for this session without touching the pointer', async () => {
      answer('Use default folder this session');
      const resolved = resolve(['--data-dir=relative']);
      await expect(runStartupDataFolderChecks(host, defaultDir, noLegacy, resolved)).resolves.toBe(false);
      expect(readPointer(defaultDir)).toBeNull();
    });

    it('offers no folder choice when a flag or env override is the cause', async () => {
      answer('Quit');
      await expect(runStartupDataFolderChecks(host, defaultDir, noLegacy, resolve(['--data-dir=relative']))).resolves.toBe(true);
      const options = host.confirm.mock.calls[0][0] as { buttons: string[] };
      expect(options.buttons).toEqual(['Use default folder this session', 'Quit']);
      expect(host.exit).toHaveBeenCalledWith(0);
    });

    it('can choose another folder when the pointer is broken', async () => {
      await writeFile(path.join(defaultDir, 'data-location.json'), '{broken');
      answer('Choose another folder…', 'Use this folder and restart');
      pick(target);
      await expect(runStartupDataFolderChecks(host, defaultDir, noLegacy, resolve())).resolves.toBe(true);
      expect(readPointer(defaultDir)).toEqual({ dataDir: target, confirmed: true });
    });
  });
});

describe('chooseDataFolder', () => {
  it('warns about a folder with unrelated files and lets the user pick again', async () => {
    const cluttered = await makeTempDir();
    await writeFile(path.join(cluttered, 'taxes.xlsx'), '');
    answer('Choose a different folder…', 'Use this folder and restart');
    pick(cluttered, target);

    await expect(chooseDataFolder(host, null, defaultDir, defaultDir)).resolves.toBe(target);
    const first = host.confirm.mock.calls[0][0] as { type: string; detail: string };
    expect(first.type).toBe('warning');
    expect(first.detail).toMatch(/other files/);
  });

  it('shows an error for an unusable folder and returns null on cancel', async () => {
    const file = path.join(target, 'file.txt');
    await writeFile(file, '');
    host.confirm.mockResolvedValueOnce(0);
    pick(file, null);

    await expect(chooseDataFolder(host, null, defaultDir, defaultDir)).resolves.toBeNull();
    const error = host.confirm.mock.calls[0][0] as { type: string };
    expect(error.type).toBe('error');
    expect(readPointer(defaultDir)).toBeNull();
  });

  it('writes a null pointer when the default folder is chosen again', async () => {
    answer('Use this folder and restart');
    pick(defaultDir);
    await expect(chooseDataFolder(host, null, defaultDir, target)).resolves.toBe(defaultDir);
    expect(readPointer(defaultDir)).toEqual({ dataDir: null, confirmed: true });
  });
});
