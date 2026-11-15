import { mkdir, readdir, readFile, copyFile, writeFile, access, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { PromptSyncResult } from '@domain/types';

const INITIALIZED_FLAG = '.initialized';

const AUTHOR_PROFILE_TEMPLATE = `# Author Profile

Describe your writing voice, themes, genres, and style here.
This is loaded by Spark and Quill to understand your creative DNA.
`;

/**
 * Check whether the first-run bootstrap has already completed.
 * Returns `true` if the `.initialized` flag file does NOT exist.
 */
export async function needsBootstrap(userDataPath: string): Promise<boolean> {
  try {
    await access(path.join(userDataPath, INITIALIZED_FLAG), fsConstants.F_OK);
    return false;
  } catch {
    // ENOENT — flag file doesn't exist, bootstrap needed
    return true;
  }
}

/** Manifest in custom-agents/: the bundled hash each prompt was installed from. */
export const PROMPT_MANIFEST = '.bundled-manifest.json';
/** Bundled with the agents: every past bundled version's hash, keyed by lower-cased filename. */
export const PROMPT_HISTORY = 'prompt-history.json';

type PromptManifest = { version: 1; files: Record<string, string> };

/** SHA-256 of a prompt with CRLF normalised to LF. Must match scripts/agent-hashes.js. */
export function hashPrompt(content: string | Buffer): string {
  const text = typeof content === 'string' ? content : content.toString('utf-8');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return null; // missing or malformed — treated as absent
  }
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Sync bundled agent `.md` files from `agentsSourceDir` into the user's
 * `custom-agents/` directory. Runs on every startup and is idempotent.
 *
 * - Missing prompts are copied.
 * - Prompts the user hasn't edited are replaced when the bundled version
 *   changes (#39). "Unedited" means the file matches the hash recorded in
 *   `.bundled-manifest.json`, or — on installs from before the manifest —
 *   matches some past bundled version listed in `prompt-history.json`.
 * - Edited prompts are never touched; they are reported in `edited`.
 *
 * This is intentionally separate from the one-time bootstrap so that users
 * who ran the app before the source directory was properly populated can
 * recover automatically without manual intervention.
 */
export async function ensureAgents(agentsDir: string, agentsSourceDir: string): Promise<PromptSyncResult> {
  // Ensure the destination directory exists (idempotent).
  await mkdir(agentsDir, { recursive: true });

  // One-time rename migration: standardize agent filenames to UPPER-CASE.md.
  // Compares against readdir's exact on-disk names — access() would match
  // case-insensitively on APFS/NTFS and silently skip these case-only renames.
  const AGENT_RENAMES: [string, string][] = [
    ['FORGE.MD', 'FORGE.md'],
    ['Quill.md', 'QUILL.md'],
  ];
  const existingNames = new Set(await readdir(agentsDir));
  for (const [oldName, newName] of AGENT_RENAMES) {
    // Skip if there's nothing to migrate, or if both files genuinely coexist
    // (possible only on case-sensitive filesystems — partial migration state).
    if (!existingNames.has(oldName) || existingNames.has(newName)) continue;
    await rename(path.join(agentsDir, oldName), path.join(agentsDir, newName));
  }

  let entries: string[];
  try {
    entries = await readdir(agentsSourceDir);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[bootstrap] Agent source directory not found:', agentsSourceDir);
      return { updated: [], edited: [] };
    }
    throw err;
  }

  /** Files to skip during agent restoration — legacy files that should not be copied. */
  const SKIP_FILES = new Set(['VERITY-LEGACY.md']);

  const mdFiles = entries.filter((f) => (f.endsWith('.md') || f.endsWith('.MD')) && !SKIP_FILES.has(f));

  const manifestPath = path.join(agentsDir, PROMPT_MANIFEST);
  const manifest = (await readJson<PromptManifest>(manifestPath)) ?? { version: 1, files: {} };
  const history = (await readJson<Record<string, string[]>>(path.join(agentsSourceDir, PROMPT_HISTORY))) ?? {};

  const updated: string[] = [];
  const edited: string[] = [];

  await Promise.all(
    mdFiles.map(async (filename) => {
      const bundled = await readFile(path.join(agentsSourceDir, filename));
      const bundledHash = hashPrompt(bundled);
      const dest = path.join(agentsDir, filename);
      const current = await readIfExists(dest);

      if (current === null) {
        await writeFile(dest, bundled);
        manifest.files[filename] = bundledHash;
        return;
      }

      const currentHash = hashPrompt(current);
      if (currentHash === bundledHash) {
        manifest.files[filename] = bundledHash; // already current
        return;
      }

      const installedHash = manifest.files[filename];
      const unedited =
        installedHash !== undefined
          ? currentHash === installedHash
          : (history[filename.toLowerCase()] ?? []).includes(currentHash);

      if (unedited) {
        await writeFile(dest, bundled);
        manifest.files[filename] = bundledHash;
        updated.push(filename);
      } else {
        // Leave the user's version alone. Without a manifest entry we record
        // nothing, so the file stays "edited" until it matches a bundled version.
        edited.push(filename);
      }
    }),
  );

  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await rename(tmp, manifestPath);

  return { updated: updated.sort(), edited: edited.sort() };
}

/**
 * Perform first-run initialization:
 *
 * 1. Create `books/` and `custom-agents/` directories.
 * 2. Copy bundled agent `.md` files into `custom-agents/` via `ensureAgents`.
 * 3. Create a template `author-profile.md` (skip if already present).
 * 4. Create `active-book.json` pointing to no book (skip if already present).
 * 5. Write the `.initialized` flag with the current ISO timestamp.
 *
 * `agentsSourceDir` — the directory containing the bundled agent `.md` files.
 * In production this is `process.resourcesPath/agents`; in dev it is
 * `{projectRoot}/agents` (the directory tracked in source control).
 */
export async function bootstrap(userDataPath: string, agentsSourceDir: string): Promise<void> {
  const booksDir = path.join(userDataPath, 'books');
  const agentsDir = path.join(userDataPath, 'custom-agents');

  // 1. Create directories (recursive — idempotent).
  await mkdir(booksDir, { recursive: true });
  await mkdir(path.join(userDataPath, 'series'), { recursive: true });

  // 2. Copy bundled agent .md files (shared logic with the recovery path).
  await ensureAgents(agentsDir, agentsSourceDir);

  // 3. Create author-profile.md template (if not already present).
  const authorProfilePath = path.join(userDataPath, 'author-profile.md');
  await writeFileIfMissing(authorProfilePath, AUTHOR_PROFILE_TEMPLATE);

  // 4. Create active-book.json pointing to no book (if not already present).
  const activeBookPath = path.join(userDataPath, 'active-book.json');
  await writeFileIfMissing(activeBookPath, JSON.stringify({ book: '' }, null, 2) + '\n');

  // 5. Write the initialization flag.
  const flagPath = path.join(userDataPath, INITIALIZED_FLAG);
  await writeFile(flagPath, new Date().toISOString(), 'utf-8');
}

/**
 * Copy the user guide to the userData directory so the Helper agent can
 * access it at runtime. Always overwrites the destination to keep the
 * guide up-to-date with the installed app version.
 *
 * @param userDataPath — the app's userData directory
 * @param guideSourcePath — absolute path to the bundled USER_GUIDE.md
 */
export async function ensureUserGuide(userDataPath: string, guideSourcePath: string): Promise<void> {
  const dest = path.join(userDataPath, 'USER_GUIDE.md');
  try {
    // Verify source exists before copying
    await stat(guideSourcePath);
    await copyFile(guideSourcePath, dest);
  } catch {
    // Source not found or copy failed — helper will work without it (degraded)
  }
}

/**
 * Write a file only if it doesn't already exist.
 */
async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK);
    // File exists — leave it alone.
  } catch {
    await writeFile(filePath, content, 'utf-8');
  }
}
