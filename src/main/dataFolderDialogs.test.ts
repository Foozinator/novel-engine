import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, dialog } from 'electron';
import { chooseDataFolder, runStartupDataFolderChecks } from './dataFolderDialogs';
import { readPointer, resolveDataDir } from './dataLocation';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';

vi.mock('electron', () => import('../test/mocks/electron'));

let defaultDir: string;
let target: string;

/** Queue message-box answers by button label, in call order. */
function answer(...labels: string[]): void {
  const queue = [...labels];
  vi.mocked(dialog.showMessageBox).mockImplementation((async (...args: unknown[]) => {
    const options = args[args.length - 1] as { buttons?: string[] };
    const label = queue.shift();
    const response = label === undefined ? 0 : (options.buttons ?? []).indexOf(label);
    if (response < 0) throw new Error(`No button "${label}" in ${JSON.stringify(options.buttons)}`);
    return { response, checkboxChecked: false };
  }) as typeof dialog.showMessageBox);
}

function pick(...dirs: (string | null)[]): void {
  for (const dir of dirs) {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(
      dir === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [dir] },
    );
  }
}

const resolve = (argv: string[] = []) => resolveDataDir({ defaultDir, argv, env: {} });

beforeEach(async () => {
  vi.clearAllMocks();
  defaultDir = await makeTempDir();
  target = await makeTempDir();
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('runStartupDataFolderChecks', () => {
  it('does nothing on a fresh install', async () => {
    await expect(runStartupDataFolderChecks(defaultDir, resolve())).resolves.toBe(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  describe('first launch on existing default data', () => {
    beforeEach(async () => {
      await writeFile(path.join(defaultDir, 'novel-engine.db'), '');
    });

    it('"Use this folder" records the answer and continues', async () => {
      answer('Use this folder');
      await expect(runStartupDataFolderChecks(defaultDir, resolve())).resolves.toBe(false);
      expect(readPointer(defaultDir)).toEqual({ dataDir: null, confirmed: true });
      expect(app.relaunch).not.toHaveBeenCalled();
    });

    it('choosing a separate folder writes the pointer and relaunches', async () => {
      answer('Choose a separate folder…', 'Use this folder and restart');
      pick(target);
      await expect(runStartupDataFolderChecks(defaultDir, resolve())).resolves.toBe(true);
      expect(readPointer(defaultDir)).toEqual({ dataDir: target, confirmed: true });
      expect(app.relaunch).toHaveBeenCalled();
    });

    it('asks again when the folder picker is cancelled', async () => {
      answer('Choose a separate folder…', 'Use this folder');
      pick(null);
      await expect(runStartupDataFolderChecks(defaultDir, resolve())).resolves.toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    });
  });

  describe('unusable folder', () => {
    it('can fall back to the default for this session without touching the pointer', async () => {
      answer('Use default folder this session');
      const resolved = resolve(['--data-dir=relative']);
      await expect(runStartupDataFolderChecks(defaultDir, resolved)).resolves.toBe(false);
      expect(readPointer(defaultDir)).toBeNull();
    });

    it('offers no folder choice when a flag or env override is the cause', async () => {
      answer('Quit');
      await expect(runStartupDataFolderChecks(defaultDir, resolve(['--data-dir=relative']))).resolves.toBe(true);
      const options = vi.mocked(dialog.showMessageBox).mock.calls[0][0] as { buttons: string[] };
      expect(options.buttons).toEqual(['Use default folder this session', 'Quit']);
      expect(app.exit).toHaveBeenCalledWith(0);
    });

    it('can choose another folder when the pointer is broken', async () => {
      await writeFile(path.join(defaultDir, 'data-location.json'), '{broken');
      answer('Choose another folder…', 'Use this folder and restart');
      pick(target);
      await expect(runStartupDataFolderChecks(defaultDir, resolve())).resolves.toBe(true);
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

    await expect(chooseDataFolder(null, defaultDir, defaultDir)).resolves.toBe(target);
    const first = vi.mocked(dialog.showMessageBox).mock.calls[0][0] as { type: string; detail: string };
    expect(first.type).toBe('warning');
    expect(first.detail).toMatch(/other files/);
  });

  it('shows an error for an unusable folder and returns null on cancel', async () => {
    const file = path.join(target, 'file.txt');
    await writeFile(file, '');
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    pick(file, null);

    await expect(chooseDataFolder(null, defaultDir, defaultDir)).resolves.toBeNull();
    const error = vi.mocked(dialog.showMessageBox).mock.calls[0][0] as { type: string };
    expect(error.type).toBe('error');
    expect(readPointer(defaultDir)).toBeNull();
  });

  it('writes a null pointer when the default folder is chosen again', async () => {
    answer('Use this folder and restart');
    pick(defaultDir);
    await expect(chooseDataFolder(null, defaultDir, target)).resolves.toBe(defaultDir);
    expect(readPointer(defaultDir)).toEqual({ dataDir: null, confirmed: true });
  });
});
