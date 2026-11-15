import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DataFolderKind, DataFolderSource } from '@domain/types';

/**
 * Data folder resolution (#39).
 *
 * Every piece of app data (DB, books, custom-agents, settings, series, author
 * profile) derives from Electron's `userData` path. This module decides which
 * folder that is, before `app.whenReady()`, so `app.setPath('userData', …)`
 * can redirect all of it at once.
 *
 * Synchronous and Electron-free so it runs at module top level and is testable.
 *
 * Priority: `--data-dir=<abs>` flag › `NOVEL_ENGINE_DATA_DIR` env ›
 * pointer file in the default folder › the default folder itself.
 */

export const POINTER_FILENAME = 'data-location.json';
export const DATA_DIR_FLAG = '--data-dir=';
export const DATA_DIR_ENV = 'NOVEL_ENGINE_DATA_DIR';

export type DataPointer = {
  /** Absolute data folder, or `null` for "use the default folder". */
  dataDir: string | null;
  /** True once the user has answered the first-launch question. */
  confirmed: boolean;
};

export type ResolvedDataDir = {
  dir: string;
  source: DataFolderSource;
  /** Set when the chosen folder can't be used; `dir` is then the default. */
  problem?: string;
  /** The folder that was requested but rejected (only with `problem`). */
  requested?: string;
  /** True when a pointer file exists and the user already answered. */
  confirmed: boolean;
};

export type ResolveInput = {
  defaultDir: string;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
};

export function pointerPath(defaultDir: string): string {
  return path.join(defaultDir, POINTER_FILENAME);
}

/**
 * Read the pointer file. Returns `null` when it doesn't exist.
 * Throws on malformed content so the caller can report it.
 */
export function readPointer(defaultDir: string): DataPointer | null {
  let raw: string;
  try {
    raw = readFileSync(pointerPath(defaultDir), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${POINTER_FILENAME} is not a JSON object`);
  }
  const { dataDir, confirmed } = parsed as Record<string, unknown>;
  if (dataDir !== null && dataDir !== undefined && typeof dataDir !== 'string') {
    throw new Error(`${POINTER_FILENAME}: dataDir must be a string or null`);
  }
  return { dataDir: typeof dataDir === 'string' ? dataDir : null, confirmed: confirmed === true };
}

/** Write the pointer atomically (tmp file + rename). */
export function writePointer(defaultDir: string, dataDir: string | null): void {
  mkdirSync(defaultDir, { recursive: true });
  const target = pointerPath(defaultDir);
  const tmp = `${target}.${process.pid}.tmp`;
  const body: DataPointer = { dataDir, confirmed: true };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

/**
 * Return a reason the folder can't be used as a data folder, or `undefined`
 * when it's fine. A missing folder is created (its parent must be writable).
 */
export function checkUsable(dir: string): string | undefined {
  if (!path.isAbsolute(dir)) return `Not an absolute path: ${dir}`;
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) return `Not a folder: ${dir}`;
    } else {
      mkdirSync(dir, { recursive: true });
    }
    const probe = path.join(dir, `.ne-write-probe-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK);
    return undefined;
  } catch (err) {
    return `Folder is not writable: ${dir} (${(err as Error).message})`;
  }
}

function flagValue(argv: readonly string[]): string | undefined {
  const arg = argv.find((a) => a.startsWith(DATA_DIR_FLAG));
  const value = arg?.slice(DATA_DIR_FLAG.length).trim();
  return value ? value : undefined;
}

export function resolveDataDir({ defaultDir, argv, env }: ResolveInput): ResolvedDataDir {
  let requested: string | undefined;
  let source: DataFolderSource = 'default';

  let pointer: DataPointer | null = null;
  let pointerProblem: string | undefined;
  try {
    pointer = readPointer(defaultDir);
  } catch (err) {
    pointerProblem = `${POINTER_FILENAME} could not be read: ${(err as Error).message}`;
  }
  const confirmed = pointer?.confirmed ?? false;

  const flag = flagValue(argv);
  const envDir = env[DATA_DIR_ENV]?.trim();
  if (flag) {
    requested = flag;
    source = 'flag';
  } else if (envDir) {
    requested = envDir;
    source = 'env';
  } else if (pointerProblem) {
    return { dir: defaultDir, source: 'pointer', problem: pointerProblem, confirmed };
  } else if (pointer?.dataDir) {
    requested = pointer.dataDir;
    source = 'pointer';
  }

  if (requested === undefined) return { dir: defaultDir, source: 'default', confirmed };

  const resolved = path.normalize(requested);
  const problem = checkUsable(resolved);
  if (problem) return { dir: defaultDir, source, problem, requested: resolved, confirmed };
  return { dir: resolved, source, confirmed };
}

/**
 * Folder name the app used before the fork was renamed to Novel Engine Spur.
 * It sits next to Spur's own default folder under Electron's `appData`, and
 * upstream Novel Engine installs still use it.
 */
export const LEGACY_DATA_FOLDER_NAME = 'Novel Engine';

/**
 * Entries Chromium/Electron writes into `userData` on its own: caches, the
 * browser profile, and per-process locks. None of it is app data, so it
 * doesn't count as content and is never copied. `Local Storage` is
 * deliberately absent: it holds renderer preferences worth keeping.
 */
const BROWSER_PROFILE_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'Dictionaries',
  'Shared Dictionary',
  'SharedStorage',
  'blob_storage',
  'Cookies',
  'Cookies-journal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'Network Persistent State',
  'TransportSecurity',
  'Preferences',
  'Session Storage',
  'Service Worker',
  'DevToolsActivePort',
  'lockfile',
]);

function isBrowserProfileEntry(name: string): boolean {
  return BROWSER_PROFILE_ENTRIES.has(name) || name.startsWith('Singleton');
}

/** Classify what a folder already holds, to word the confirm dialog. */
export function classifyFolder(dir: string): DataFolderKind {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 'empty'; // missing folder — will be created
  }
  if (entries.includes('.initialized') || entries.includes('novel-engine.db')) return 'novel-engine';
  // Pointer file, browser-profile files and OS clutter don't count as content.
  const ignorable = new Set([POINTER_FILENAME, '.DS_Store', 'Thumbs.db', 'desktop.ini']);
  return entries.some((e) => !ignorable.has(e) && !isBrowserProfileEntry(e)) ? 'other' : 'empty';
}

/**
 * True when this launch should offer to bring over data from the pre-rename
 * `Novel Engine` folder: no override, not asked before, Spur's own default
 * folder has no app data yet, and the legacy folder does.
 */
export function needsLegacyImport(defaultDir: string, legacyDir: string, resolved: ResolvedDataDir): boolean {
  if (resolved.source !== 'default' || resolved.problem || resolved.confirmed) return false;
  if (path.resolve(legacyDir) === path.resolve(defaultDir)) return false;
  return classifyFolder(defaultDir) !== 'novel-engine' && classifyFolder(legacyDir) === 'novel-engine';
}

/**
 * Copy app data from `fromDir` into `toDir`, skipping browser-profile files
 * and the pointer file. Existing files in `toDir` are never overwritten.
 * On failure, removes what it copied and rethrows. Returns the copied
 * top-level entry names.
 */
export async function copyAppData(fromDir: string, toDir: string): Promise<string[]> {
  mkdirSync(toDir, { recursive: true });
  const existing = new Set(readdirSync(toDir));
  const entries = readdirSync(fromDir).filter(
    (name) => name !== POINTER_FILENAME && !isBrowserProfileEntry(name) && !existing.has(name),
  );
  const copied: string[] = [];
  try {
    for (const name of entries) {
      await cp(path.join(fromDir, name), path.join(toDir, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      copied.push(name);
    }
  } catch (err) {
    await Promise.all(
      [...copied, ...entries.slice(copied.length, copied.length + 1)].map((name) =>
        rm(path.join(toDir, name), { recursive: true, force: true }),
      ),
    );
    throw err;
  }
  return copied;
}
