import type { IFileSystemService } from '@domain/interfaces';

/**
 * Versioned archives of agent outputs (#81).
 *
 * The app keeps every earlier report and plan, not the agents. An archive
 * sits next to its live file with a version suffix:
 * `source/reader-report.md` → `source/reader-report-v3.md`. Each new archive
 * takes the next free version number. Nothing here overwrites or deletes an
 * archive.
 */

/** Forge's plan: the task list and the session prompts. Archived together. */
export const PLAN_FILES = ['source/project-tasks.md', 'source/revision-prompts.md'] as const;

/** Handoff notes Verity writes while running a plan. Archived with the plan it belongs to. */
export const SESSION_HANDOFFS_DIR = 'source/session-handoffs';

export const READER_REPORT = 'source/reader-report.md';
export const DEV_REPORT = 'source/dev-report.md';

type PathParts = { dir: string; stem: string; ext: string };

function splitPath(livePath: string): PathParts {
  const slash = livePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : livePath.slice(0, slash);
  const name = livePath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? { dir, stem: name.slice(0, dot), ext: name.slice(dot) }
    : { dir, stem: name, ext: '' };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `source/reader-report.md`, 3 → `source/reader-report-v3.md`. Directories get the suffix too. */
export function archivePath(livePath: string, version: number): string {
  const { dir, stem, ext } = splitPath(livePath);
  return `${dir ? `${dir}/` : ''}${stem}-v${version}${ext}`;
}

/** Version numbers of `livePath`'s archives on disk, ascending. */
export async function archiveVersions(
  fs: IFileSystemService,
  bookSlug: string,
  livePath: string,
): Promise<number[]> {
  const { dir, stem, ext } = splitPath(livePath);
  const pattern = new RegExp(`^${escapeRegExp(stem)}-v(\\d+)${escapeRegExp(ext)}$`);
  let names: string[];
  try {
    names = (await fs.listDirectory(bookSlug, dir || undefined)).map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .map((name) => pattern.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((version) => version > 0)
    .sort((a, b) => a - b);
}

/** Path of the newest archive of `livePath`, or null when it has none. */
export async function latestArchive(
  fs: IFileSystemService,
  bookSlug: string,
  livePath: string,
): Promise<string | null> {
  const versions = await archiveVersions(fs, bookSlug, livePath);
  return versions.length > 0 ? archivePath(livePath, versions[versions.length - 1]) : null;
}

/** The newest archived plan: its version and whichever of its two files exist. */
export type PlanArchive = {
  version: number;
  tasks: string | null;
  prompts: string | null;
};

/**
 * The newest plan archive. Plan and prompts share version numbers, so the
 * newest version across both files is the newest plan. Books archived by the
 * old agent rule may have only `project-tasks-v1.md`; then `prompts` is null.
 */
export async function latestPlanArchive(
  fs: IFileSystemService,
  bookSlug: string,
): Promise<PlanArchive | null> {
  const [tasksVersions, promptsVersions] = await Promise.all(
    PLAN_FILES.map((file) => archiveVersions(fs, bookSlug, file)),
  );
  const version = Math.max(0, ...tasksVersions, ...promptsVersions);
  if (version === 0) return null;
  return {
    version,
    tasks: tasksVersions.includes(version) ? archivePath(PLAN_FILES[0], version) : null,
    prompts: promptsVersions.includes(version) ? archivePath(PLAN_FILES[1], version) : null,
  };
}

export type ArchiveMode = 'copy' | 'move';

export type ArchiveResult = {
  /** Version the live files are archived under. */
  version: number;
  /** False when the newest archive already held this content, so no new archive was written. */
  created: boolean;
};

async function readOrNull(fs: IFileSystemService, bookSlug: string, path: string): Promise<string | null> {
  try {
    return await fs.readFile(bookSlug, path);
  } catch {
    return null;
  }
}

/**
 * Archive a group of live files under one shared version number.
 *
 * - `copy` leaves the live files in place (reports: later phases read them).
 * - `move` removes them (Forge's plan: the next run starts clean).
 *
 * When every live file that exists already matches its archive at the newest
 * version, no new archive is written (a `move` then only removes the live
 * files). Otherwise every live file that exists is archived under the next
 * free version. Returns null when none of the live files exist.
 */
export async function archiveGroup(
  fs: IFileSystemService,
  bookSlug: string,
  livePaths: readonly string[],
  mode: ArchiveMode,
): Promise<ArchiveResult | null> {
  const live: { path: string; content: string }[] = [];
  for (const path of livePaths) {
    const content = await readOrNull(fs, bookSlug, path);
    if (content !== null) live.push({ path, content });
  }
  if (live.length === 0) return null;

  const versionLists = await Promise.all(livePaths.map((path) => archiveVersions(fs, bookSlug, path)));
  const newest = Math.max(0, ...versionLists.flat());

  let alreadyArchived = newest > 0;
  for (const file of live) {
    if (!alreadyArchived) break;
    const archived = await readOrNull(fs, bookSlug, archivePath(file.path, newest));
    alreadyArchived = archived === file.content;
  }

  const version = alreadyArchived ? newest : newest + 1;
  for (const file of live) {
    if (!alreadyArchived) {
      if (mode === 'move') {
        await fs.renameFile(bookSlug, file.path, archivePath(file.path, version));
        continue;
      }
      await fs.writeFile(bookSlug, archivePath(file.path, version), file.content);
    } else if (mode === 'move') {
      await fs.deleteFile(bookSlug, file.path);
    }
  }
  return { version, created: !alreadyArchived };
}

/**
 * Archive Forge's plan: task list and session prompts under one version.
 *
 * A `move` also moves `source/session-handoffs/` (when it holds anything) to
 * `source/session-handoffs-vN/`, so the next plan's sessions don't read the
 * last plan's handoffs. If that name is taken, the next free one is used.
 */
export async function archivePlan(
  fs: IFileSystemService,
  bookSlug: string,
  mode: ArchiveMode,
): Promise<ArchiveResult | null> {
  const result = await archiveGroup(fs, bookSlug, PLAN_FILES, mode);
  if (mode !== 'move') return result;

  let handoffs: string[] = [];
  try {
    handoffs = (await fs.listDirectory(bookSlug, SESSION_HANDOFFS_DIR)).map((entry) => entry.name);
  } catch {
    // No handoffs directory — nothing to move
  }
  if (handoffs.length === 0) return result;

  const taken = new Set(await archiveVersions(fs, bookSlug, SESSION_HANDOFFS_DIR));
  let version = result?.version ?? (await latestPlanArchive(fs, bookSlug))?.version ?? 1;
  while (taken.has(version)) version++;
  await fs.renameFile(bookSlug, SESSION_HANDOFFS_DIR, archivePath(SESSION_HANDOFFS_DIR, version));
  return result ?? { version, created: true };
}
