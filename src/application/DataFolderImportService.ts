import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  IDataFolderImportService,
  IDatabaseService,
  ISeriesService,
  ISourceDataFolder,
  OpenSourceDataFolder,
} from '@domain/interfaces';
import type {
  DataFolderBookSummary,
  DataFolderImportConfig,
  DataFolderImportResult,
  DataFolderPreview,
  SeriesMeta,
} from '@domain/types';
import { BOOK_HISTORY_DIR, BOOK_HISTORY_FILE, HELPER_SLUG, PITCH_ROOM_SLUG } from '@domain/constants';

export type DataFolderImportPaths = {
  /** This app's data folder. */
  userDataPath: string;
  /** This app's `books/` directory. */
  booksDir: string;
  /** Where staging dirs are created (os.tmpdir() in production). */
  tmpRoot: string;
};

/**
 * Import books from another Novel Engine data folder (#37).
 *
 * Each book is staged in a temp dir as its folder plus
 * `.novel-engine/history.sqlite` (exported from a migrated temp copy of the
 * source DB), then installed: the history is merged into this app's DB and
 * the folder is moved into `books/`. A book either arrives whole or not at
 * all. The source folder is never written.
 *
 * Staging and installing are the export and import halves that #36's
 * archive/backup zip will reuse.
 */
export class DataFolderImportService implements IDataFolderImportService {
  constructor(
    private db: IDatabaseService,
    private series: ISeriesService,
    private openSource: OpenSourceDataFolder,
    private paths: DataFolderImportPaths,
    /** The bootstrap author-profile template; a profile equal to it counts as empty. */
    private defaultAuthorProfile: string,
  ) {}

  async preview(sourcePath: string): Promise<DataFolderPreview> {
    const src = await this.openSource(sourcePath);
    try {
      const books: DataFolderBookSummary[] = [];
      for (const slug of await listBookFolders(src.booksDir)) {
        const bookDir = path.join(src.booksDir, slug);
        const about = await readAbout(bookDir);
        const { wordCount, chapterCount } = await countChapters(bookDir);
        const stats = src.db.getBookHistoryStats(slug);
        const ids = src.db.listConversationIds(slug);
        books.push({
          slug,
          title: about.title || slug,
          author: about.author,
          wordCount,
          chapterCount,
          conversationCount: stats.conversationCount,
          historyBytes: stats.historyBytes,
          folderExists: await this.slugTaken(slug),
          alreadyImported: this.db.findExistingConversationIds(ids).length > 0,
        });
      }
      books.sort((a, b) => a.title.localeCompare(b.title));

      return {
        sourcePath: src.rootDir,
        sourceSchemaVersion: src.schemaVersion,
        books,
        hasAuthorProfile: (await this.readSourceAuthorProfile(src)) !== null,
        seriesSlugs: await listSeriesDirs(path.join(src.rootDir, 'series')),
      };
    } finally {
      await src.close();
    }
  }

  async commit(config: DataFolderImportConfig): Promise<DataFolderImportResult> {
    const result: DataFolderImportResult = { imported: [], skipped: [], warnings: [] };
    const src = await this.openSource(config.sourcePath);
    const stageRoot = await mkdtemp(path.join(this.paths.tmpRoot, 'novel-engine-stage-'));
    /** source slug → target slug, for books imported in this run */
    const slugMap = new Map<string, string>();

    try {
      const available = new Set(await listBookFolders(src.booksDir));

      for (const book of config.books) {
        if (book.action === 'skip') {
          result.skipped.push({ slug: book.slug, reason: 'Skipped' });
          continue;
        }
        if (!available.has(book.slug)) {
          result.skipped.push({ slug: book.slug, reason: 'Not found in the source folder' });
          continue;
        }

        const targetSlug = book.action === 'rename' ? slugify(book.newTitle ?? '') : book.slug;
        if (!targetSlug) {
          result.skipped.push({ slug: book.slug, reason: 'The new title gives an empty folder name' });
          continue;
        }
        if (await this.slugTaken(targetSlug)) {
          result.skipped.push({ slug: book.slug, reason: `A book in folder "${targetSlug}" already exists here` });
          continue;
        }
        if (this.db.findExistingConversationIds(src.db.listConversationIds(book.slug)).length > 0) {
          result.skipped.push({ slug: book.slug, reason: 'Already imported: its chats already exist here' });
          continue;
        }

        try {
          const newTitle = book.action === 'rename' ? book.newTitle?.trim() : undefined;
          const imported = await this.importOne(src, book.slug, targetSlug, newTitle, stageRoot);
          result.imported.push(imported);
          slugMap.set(book.slug, targetSlug);
        } catch (err) {
          result.skipped.push({ slug: book.slug, reason: `Failed: ${errorMessage(err)}` });
        }
      }

      if (config.copySeries && slugMap.size > 0) {
        await this.copySeries(src, slugMap, result.warnings);
      }
      if (config.copyAuthorProfile) {
        await this.copyAuthorProfile(src, result.warnings);
      }
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
      await src.close();
    }

    return result;
  }

  // ── Books ──────────────────────────────────────────────────────────

  private async importOne(
    src: ISourceDataFolder,
    slug: string,
    targetSlug: string,
    newTitle: string | undefined,
    stageRoot: string,
  ): Promise<DataFolderImportResult['imported'][number]> {
    // Stage: folder + history snapshot (the #36 archive layout).
    const stage = path.join(stageRoot, targetSlug);
    await cp(path.join(src.booksDir, slug), stage, { recursive: true, errorOnExist: true, force: false });
    const historyDir = path.join(stage, BOOK_HISTORY_DIR);
    await rm(historyDir, { recursive: true, force: true }); // never trust one shipped inside a live folder
    await mkdir(historyDir);
    const historyFile = path.join(historyDir, BOOK_HISTORY_FILE);
    src.db.exportBookHistory(slug, historyFile);

    const about = await readAbout(stage);
    let title = about.title || slug;
    if (newTitle) {
      title = newTitle;
      await writeAbout(stage, { ...about.raw, title });
    }

    // Install: copy beside books/ under a hidden name, merge history, then rename into place.
    const pending = path.join(this.paths.booksDir, `_importing-${targetSlug}`);
    const finalDir = path.join(this.paths.booksDir, targetSlug);
    await rm(pending, { recursive: true, force: true });
    // Copy, then drop the history dir: a cp filter compares path strings, which differ in form on Windows.
    await cp(stage, pending, { recursive: true });
    await rm(path.join(pending, BOOK_HISTORY_DIR), { recursive: true, force: true });

    let receipt: ReturnType<IDatabaseService['importBookHistory']> | null = null;
    try {
      receipt = this.db.importBookHistory(historyFile, targetSlug);
      if (existsSync(finalDir)) throw new Error(`A book in folder "${targetSlug}" appeared during import`);
      await rename(pending, finalDir);
    } catch (err) {
      if (receipt) this.db.revertBookHistoryImport(receipt);
      await rm(pending, { recursive: true, force: true });
      throw err;
    }

    return {
      from: slug,
      to: targetSlug,
      title,
      conversations: receipt.counts.conversations,
      versions: receipt.counts.fileVersions,
    };
  }

  /** A slug is taken by a live or archived folder, or by leftover DB history. */
  private async slugTaken(slug: string): Promise<boolean> {
    if (existsSync(path.join(this.paths.booksDir, slug))) return true;
    if (existsSync(path.join(this.paths.booksDir, '_archived', slug))) return true;
    const stats = this.db.getBookHistoryStats(slug);
    return stats.conversationCount > 0 || stats.historyBytes > 0;
  }

  // ── Series ─────────────────────────────────────────────────────────

  private async copySeries(src: ISourceDataFolder, slugMap: Map<string, string>, warnings: string[]): Promise<void> {
    const srcRoot = path.join(src.rootDir, 'series');
    const dstRoot = path.join(this.paths.userDataPath, 'series');
    let copied = false;

    for (const seriesSlug of await listSeriesDirs(srcRoot)) {
      let meta: SeriesMeta;
      try {
        meta = JSON.parse(await readFile(path.join(srcRoot, seriesSlug, 'series.json'), 'utf-8')) as SeriesMeta;
      } catch {
        warnings.push(`Series "${seriesSlug}" has an unreadable series.json and was not copied.`);
        continue;
      }
      const volumes = Array.isArray(meta.volumes) ? meta.volumes : [];
      if (!volumes.some((v) => slugMap.has(v.bookSlug))) continue; // not about the books imported

      if (existsSync(path.join(dstRoot, seriesSlug))) {
        warnings.push(`Series "${meta.name || seriesSlug}" already exists here and was not copied.`);
        continue;
      }

      const kept: SeriesMeta['volumes'] = [];
      for (const v of volumes) {
        const mapped = slugMap.get(v.bookSlug);
        if (mapped) kept.push({ ...v, bookSlug: mapped });
        else if (existsSync(path.join(this.paths.booksDir, v.bookSlug))) kept.push(v);
        else warnings.push(`Series "${meta.name || seriesSlug}": volume ${v.volumeNumber} ("${v.bookSlug}") was not imported, so it was left out.`);
      }

      await mkdir(dstRoot, { recursive: true });
      await cp(path.join(srcRoot, seriesSlug), path.join(dstRoot, seriesSlug), { recursive: true, errorOnExist: true, force: false });
      await writeFile(
        path.join(dstRoot, seriesSlug, 'series.json'),
        JSON.stringify({ ...meta, volumes: kept }, null, 2),
        'utf-8',
      );
      copied = true;
    }

    if (copied) this.series.invalidateCache();
  }

  // ── Author profile ─────────────────────────────────────────────────

  /** The source profile, or null when it is missing or still the template. */
  private async readSourceAuthorProfile(src: ISourceDataFolder): Promise<string | null> {
    const text = await readFile(path.join(src.rootDir, 'author-profile.md'), 'utf-8').catch(() => null);
    if (text === null || this.isTemplate(text)) return null;
    return text;
  }

  private async copyAuthorProfile(src: ISourceDataFolder, warnings: string[]): Promise<void> {
    const incoming = await this.readSourceAuthorProfile(src);
    if (incoming === null) return;
    const dst = path.join(this.paths.userDataPath, 'author-profile.md');
    const current = await readFile(dst, 'utf-8').catch(() => null);
    if (current !== null && current === incoming) return;
    if (current !== null && !this.isTemplate(current)) {
      warnings.push('Your author profile here was kept. The source folder’s profile was not copied.');
      return;
    }
    await writeFile(dst, incoming, 'utf-8');
  }

  private isTemplate(text: string): boolean {
    return text.trim() === '' || text.trim() === this.defaultAuthorProfile.trim();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Book folders as listBooks sees them: no `_`/`.` prefixes, no pseudo-books. */
async function listBookFolders(booksDir: string): Promise<string[]> {
  const entries = await readdir(booksDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && n !== PITCH_ROOM_SLUG && n !== HELPER_SLUG);
}

async function listSeriesDirs(seriesRoot: string): Promise<string[]> {
  const entries = await readdir(seriesRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(seriesRoot, e.name, 'series.json')))
    .map((e) => e.name)
    .sort();
}

async function readAbout(bookDir: string): Promise<{ title: string; author: string; raw: Record<string, unknown> }> {
  try {
    const raw = JSON.parse(await readFile(path.join(bookDir, 'about.json'), 'utf-8')) as Record<string, unknown>;
    return { title: String(raw.title ?? ''), author: String(raw.author ?? ''), raw };
  } catch {
    return { title: '', author: '', raw: {} };
  }
}

async function writeAbout(bookDir: string, about: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(bookDir, 'about.json'), JSON.stringify(about, null, 2), 'utf-8');
}

/** Same rule as FileSystemService.countWords: body chapters only, front matter excluded. */
async function countChapters(bookDir: string): Promise<{ wordCount: number; chapterCount: number }> {
  const chaptersDir = path.join(bookDir, 'chapters');
  const entries = await readdir(chaptersDir, { withFileTypes: true }).catch(() => []);
  let wordCount = 0;
  let chapterCount = 0;
  for (const e of entries) {
    if (!e.isDirectory() || /^00-\d+-/.test(e.name)) continue;
    chapterCount += 1;
    const text = await readFile(path.join(chaptersDir, e.name, 'draft.md'), 'utf-8').catch(() => '');
    wordCount += text.split(/\s+/).filter(Boolean).length;
  }
  return { wordCount, chapterCount };
}

/** Same rule as FileSystemService.slugify. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
