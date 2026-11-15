import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROMPT_HISTORY,
  PROMPT_MANIFEST,
  bootstrap,
  ensureAgents,
  ensureUserGuide,
  hashPrompt,
  needsBootstrap,
} from './bootstrap';
import { cleanupTempDirs, makeTempDir } from '../test/tempDir';

let userDataPath: string;
let agentsSourceDir: string;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  userDataPath = await makeTempDir();
  agentsSourceDir = await makeTempDir();
  await writeFile(path.join(agentsSourceDir, 'SPARK.md'), 'spark prompt', 'utf-8');
  await writeFile(path.join(agentsSourceDir, 'VERITY-CORE.md'), 'verity prompt', 'utf-8');
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('needsBootstrap', () => {
  it('is true before first run and false after bootstrap completes', async () => {
    expect(await needsBootstrap(userDataPath)).toBe(true);
    await bootstrap(userDataPath, agentsSourceDir);
    expect(await needsBootstrap(userDataPath)).toBe(false);
  });
});

describe('bootstrap', () => {
  it('creates directories, copies agents, and writes template files + flag', async () => {
    await bootstrap(userDataPath, agentsSourceDir);

    expect(await exists(path.join(userDataPath, 'books'))).toBe(true);
    expect(await exists(path.join(userDataPath, 'series'))).toBe(true);
    expect(await readdir(path.join(userDataPath, 'custom-agents'))).toEqual(
      expect.arrayContaining(['SPARK.md', 'VERITY-CORE.md'])
    );
    expect(await readFile(path.join(userDataPath, 'author-profile.md'), 'utf-8')).toContain('# Author Profile');
    expect(JSON.parse(await readFile(path.join(userDataPath, 'active-book.json'), 'utf-8'))).toEqual({ book: '' });
    const flag = await readFile(path.join(userDataPath, '.initialized'), 'utf-8');
    expect(new Date(flag).toString()).not.toBe('Invalid Date');
  });

  it('is idempotent and never overwrites user files on a second run', async () => {
    await bootstrap(userDataPath, agentsSourceDir);
    await writeFile(path.join(userDataPath, 'author-profile.md'), 'my custom voice', 'utf-8');
    await writeFile(path.join(userDataPath, 'custom-agents', 'SPARK.md'), 'customized spark', 'utf-8');
    await writeFile(path.join(userDataPath, 'active-book.json'), '{"book":"my-book"}', 'utf-8');

    await bootstrap(userDataPath, agentsSourceDir);

    expect(await readFile(path.join(userDataPath, 'author-profile.md'), 'utf-8')).toBe('my custom voice');
    expect(await readFile(path.join(userDataPath, 'custom-agents', 'SPARK.md'), 'utf-8')).toBe('customized spark');
    expect(await readFile(path.join(userDataPath, 'active-book.json'), 'utf-8')).toBe('{"book":"my-book"}');
  });
});

describe('ensureAgents', () => {
  it('copies only missing .md/.MD files and skips VERITY-LEGACY.md', async () => {
    await writeFile(path.join(agentsSourceDir, 'VERITY-LEGACY.md'), 'legacy', 'utf-8');
    await writeFile(path.join(agentsSourceDir, 'HELPER.MD'), 'helper', 'utf-8');
    await writeFile(path.join(agentsSourceDir, 'notes.txt'), 'not an agent', 'utf-8');
    const agentsDir = path.join(userDataPath, 'custom-agents');

    await ensureAgents(agentsDir, agentsSourceDir);

    const copied = (await readdir(agentsDir)).sort();
    expect(copied).toEqual([PROMPT_MANIFEST, 'HELPER.MD', 'SPARK.md', 'VERITY-CORE.md']);
  });

  it('renames legacy-cased agent files even on case-insensitive filesystems', async () => {
    // The migration pairs are CASE-ONLY renames. The implementation compares
    // readdir's exact on-disk names (access() would match case-insensitively
    // on APFS/NTFS and skip the rename), so this works on both fs types.
    const agentsDir = path.join(userDataPath, 'custom-agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, 'FORGE.MD'), 'old-cased forge', 'utf-8');
    await writeFile(path.join(agentsDir, 'Quill.md'), 'old-cased quill', 'utf-8');

    await ensureAgents(agentsDir, agentsSourceDir);

    const names = await readdir(agentsDir);
    expect(names).toContain('FORGE.md');
    expect(names).not.toContain('FORGE.MD');
    expect(names).toContain('QUILL.md');
    expect(names).not.toContain('Quill.md');
    // Content survives the rename
    expect(await readFile(path.join(agentsDir, 'FORGE.md'), 'utf-8')).toBe('old-cased forge');
    expect(await readFile(path.join(agentsDir, 'QUILL.md'), 'utf-8')).toBe('old-cased quill');
  });

  it('leaves both files alone when old and new genuinely coexist', async () => {
    const agentsDir = path.join(userDataPath, 'custom-agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, 'probe.md'), 'probe', 'utf-8');
    const caseInsensitive = await exists(path.join(agentsDir, 'PROBE.MD'));
    if (caseInsensitive) return; // both files cannot coexist on this fs

    await writeFile(path.join(agentsDir, 'FORGE.MD'), 'old forge', 'utf-8');
    await writeFile(path.join(agentsDir, 'FORGE.md'), 'new forge', 'utf-8');

    await ensureAgents(agentsDir, agentsSourceDir);

    expect(await readFile(path.join(agentsDir, 'FORGE.MD'), 'utf-8')).toBe('old forge');
    expect(await readFile(path.join(agentsDir, 'FORGE.md'), 'utf-8')).toBe('new forge');
  });

  it('warns and returns when the source directory is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const agentsDir = path.join(userDataPath, 'custom-agents');

    await expect(ensureAgents(agentsDir, path.join(userDataPath, 'no-such-dir'))).resolves.toEqual({
      updated: [],
      edited: [],
    });

    expect(warn).toHaveBeenCalledWith('[bootstrap] Agent source directory not found:', expect.stringContaining('no-such-dir'));
    expect(await readdir(agentsDir)).toEqual([]); // dir created, nothing copied
  });
});

describe('ensureAgents prompt sync (#39)', () => {
  let agentsDir: string;
  const read = (name: string) => readFile(path.join(agentsDir, name), 'utf-8');
  const write = (dir: string, name: string, content: string) => writeFile(path.join(dir, name), content, 'utf-8');
  const manifest = async () =>
    JSON.parse(await readFile(path.join(agentsDir, PROMPT_MANIFEST), 'utf-8')) as { files: Record<string, string> };

  beforeEach(() => {
    agentsDir = path.join(userDataPath, 'custom-agents');
  });

  it('records the installed hash of every copied prompt', async () => {
    expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: [], edited: [] });
    expect((await manifest()).files).toEqual({
      'SPARK.md': hashPrompt('spark prompt'),
      'VERITY-CORE.md': hashPrompt('verity prompt'),
    });
  });

  it('replaces an unedited prompt when the bundled version changes', async () => {
    await ensureAgents(agentsDir, agentsSourceDir);
    await write(agentsSourceDir, 'SPARK.md', 'spark prompt v2');

    expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: ['SPARK.md'], edited: [] });
    expect(await read('SPARK.md')).toBe('spark prompt v2');
    expect((await manifest()).files['SPARK.md']).toBe(hashPrompt('spark prompt v2'));
  });

  it('keeps an edited prompt, reports it, and keeps reporting it', async () => {
    await ensureAgents(agentsDir, agentsSourceDir);
    await write(agentsDir, 'SPARK.md', 'my spark');
    await write(agentsSourceDir, 'SPARK.md', 'spark prompt v2');

    expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: [], edited: ['SPARK.md'] });
    expect(await read('SPARK.md')).toBe('my spark');
    expect((await manifest()).files['SPARK.md']).toBe(hashPrompt('spark prompt')); // baseline kept
    expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: [], edited: ['SPARK.md'] });
  });

  it('does not report an edited prompt that matches the bundled version', async () => {
    await ensureAgents(agentsDir, agentsSourceDir);
    await write(agentsSourceDir, 'SPARK.md', 'spark prompt v2');
    await write(agentsDir, 'SPARK.md', 'spark prompt v2'); // user applied the fix by hand

    expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: [], edited: [] });
  });

  describe('installs from before the manifest', () => {
    beforeEach(async () => {
      await mkdir(agentsDir, { recursive: true });
      await write(agentsSourceDir, 'SPARK.md', 'spark prompt v2');
      await write(
        agentsSourceDir,
        PROMPT_HISTORY,
        JSON.stringify({ 'spark.md': [hashPrompt('spark prompt'), hashPrompt('spark prompt v2')] }),
      );
    });

    it('replaces a prompt matching a past bundled version', async () => {
      await write(agentsDir, 'SPARK.md', 'spark prompt');
      expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: ['SPARK.md'], edited: [] });
      expect(await read('SPARK.md')).toBe('spark prompt v2');
    });

    it('matches past versions across CRLF line endings', async () => {
      await write(agentsSourceDir, 'VERITY-CORE.md', 'verity\nv2\n');
      await write(
        agentsSourceDir,
        PROMPT_HISTORY,
        JSON.stringify({ 'verity-core.md': [hashPrompt('verity\nv1\n'), hashPrompt('verity\nv2\n')] }),
      );
      await write(agentsDir, 'VERITY-CORE.md', 'verity\r\nv1\r\n');
      expect((await ensureAgents(agentsDir, agentsSourceDir)).updated).toEqual(['VERITY-CORE.md']);
    });

    it('treats an unknown version as edited and records no baseline', async () => {
      await write(agentsDir, 'SPARK.md', 'hand-written spark');
      expect(await ensureAgents(agentsDir, agentsSourceDir)).toEqual({ updated: [], edited: ['SPARK.md'] });
      expect(await read('SPARK.md')).toBe('hand-written spark');
      expect((await manifest()).files['SPARK.md']).toBeUndefined();
    });
  });

  it('never copies the history file or manifest as an agent', async () => {
    await write(agentsSourceDir, PROMPT_HISTORY, '{}');
    await ensureAgents(agentsDir, agentsSourceDir);
    expect((await readdir(agentsDir)).sort()).toEqual([PROMPT_MANIFEST, 'SPARK.md', 'VERITY-CORE.md']);
  });
});

describe('agents/prompt-history.json', () => {
  it('lists the current version of every bundled prompt (run `npm run agent-hashes`)', async () => {
    const repoAgents = path.resolve(__dirname, '../../agents');
    const history = JSON.parse(await readFile(path.join(repoAgents, PROMPT_HISTORY), 'utf-8')) as Record<
      string,
      string[]
    >;
    const prompts = (await readdir(repoAgents)).filter((f) => f.toLowerCase().endsWith('.md'));
    expect(prompts.length).toBeGreaterThan(0);
    const missing = [];
    for (const name of prompts) {
      const hash = hashPrompt(await readFile(path.join(repoAgents, name)));
      if (!history[name.toLowerCase()]?.includes(hash)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

describe('ensureUserGuide', () => {
  it('copies the guide and overwrites a stale copy on every call', async () => {
    const guideSource = path.join(agentsSourceDir, 'USER_GUIDE.md');
    await writeFile(guideSource, 'v2 guide', 'utf-8');
    await writeFile(path.join(userDataPath, 'USER_GUIDE.md'), 'v1 guide', 'utf-8');

    await ensureUserGuide(userDataPath, guideSource);

    expect(await readFile(path.join(userDataPath, 'USER_GUIDE.md'), 'utf-8')).toBe('v2 guide');
  });

  it('degrades silently when the source guide is missing', async () => {
    await expect(
      ensureUserGuide(userDataPath, path.join(agentsSourceDir, 'missing-guide.md'))
    ).resolves.toBeUndefined();
    expect(await exists(path.join(userDataPath, 'USER_GUIDE.md'))).toBe(false);
  });
});
