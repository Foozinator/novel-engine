import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataFolderLock, readHolderInfo } from './DataFolderLock';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';

afterEach(cleanupTempDirs);

describe('acquireDataFolderLock', () => {
  it('refuses a second holder and reports the first', async () => {
    const dir = await makeTempDir();
    const first = acquireDataFolderLock(dir, 'App A');
    expect(first.acquired).toBe(true);
    const second = acquireDataFolderLock(dir, 'App B');
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.holder?.app).toBe('App A');
    if (first.acquired) first.release();
  });

  it('can be taken again after release', async () => {
    const dir = await makeTempDir();
    const first = acquireDataFolderLock(dir, 'A');
    if (first.acquired) first.release();
    const again = acquireDataFolderLock(dir, 'B');
    expect(again.acquired).toBe(true);
    if (again.acquired) again.release();
    expect(readHolderInfo(dir)?.app).toBe('B');
  });

  it('is refused across processes and freed when the holder is killed', async () => {
    const dir = await makeTempDir();
    const script = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1] + '/instance.lock', { timeout: 0 });
      db.exec('BEGIN EXCLUSIVE');
      console.log('locked');
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: process.cwd(),
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('locked') && resolve());
      child.on('error', reject);
      child.on('exit', () => reject(new Error('child exited early')));
    }).catch((e) => {
      child.kill('SIGKILL');
      throw e;
    });

    expect(acquireDataFolderLock(dir, 'Other').acquired).toBe(false);

    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGKILL');
    await exited;

    const after = acquireDataFolderLock(dir, 'Other');
    expect(after.acquired).toBe(true);
    if (after.acquired) after.release();
  });
});
