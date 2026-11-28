import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';
import { SHADOW_LOG_PATH, makeShadowReporter } from './shadowLog';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe('makeShadowReporter', () => {
  it('appends each report as a JSON line with a time, creating the logs folder', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = await makeTempDir();
    const { report, flush } = makeShadowReporter(dir, () => '2026-11-28T12:00:00.000Z');

    report({ kind: 'migrated', bookSlug: 'a-book', notice: null });
    report({
      kind: 'mismatch',
      bookSlug: 'a-book',
      mismatches: [{ phase: 'second-read', legacy: 'active', log: 'pending-completion' }],
    });
    await flush();

    const lines = (await readFile(path.join(dir, SHADOW_LOG_PATH), 'utf-8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { at: '2026-11-28T12:00:00.000Z', kind: 'migrated', bookSlug: 'a-book', notice: null },
      {
        at: '2026-11-28T12:00:00.000Z',
        kind: 'mismatch',
        bookSlug: 'a-book',
        mismatches: [{ phase: 'second-read', legacy: 'active', log: 'pending-completion' }],
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1); // the mismatch; a migration is only logged
  });

  it('a failed write is logged and the next report still goes through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = await makeTempDir();
    // A file where the logs folder should be
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'logs'), 'not a folder');
    const { report, flush } = makeShadowReporter(dir);

    report({ kind: 'error', bookSlug: 'b', during: 'detect', message: 'x' });
    await flush();

    expect(warn).toHaveBeenCalledWith('[run-log] could not write the shadow log:', expect.anything());
  });
});
