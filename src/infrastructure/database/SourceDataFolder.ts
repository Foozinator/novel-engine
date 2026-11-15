import { copyFile, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ISourceDataFolder, OpenSourceDataFolder } from '@domain/interfaces';
import { DatabaseService } from './DatabaseService';

const DB_FILE = 'novel-engine.db';

/**
 * Build an opener for other Novel Engine data folders (#37).
 *
 * The source may belong to a running app (for example an upstream install),
 * so it is never opened in place: `DatabaseService` sets WAL mode and runs
 * migrations on open, and even a read-only SQLite open can write `-shm`.
 * Instead the DB and its `-wal` are copied to a temp dir and the copy is
 * opened and migrated. SQLite rebuilds `-shm` from the WAL on first open.
 *
 * If the source app commits while the copy is taken, the copy may miss that
 * commit. Closing the source app first gives an exact copy.
 */
export function makeSourceDataFolderOpener(ownUserDataPath: string, tmpRoot: string): OpenSourceDataFolder {
  return async (dataFolder: string): Promise<ISourceDataFolder> => {
    const rootDir = path.resolve(dataFolder);
    const [src, own] = await Promise.all([
      realpath(rootDir).catch(() => rootDir),
      realpath(ownUserDataPath).catch(() => path.resolve(ownUserDataPath)),
    ]);
    if (src === own) {
      throw new Error('That is this app’s own data folder. Pick a different Novel Engine folder.');
    }

    const dbPath = path.join(rootDir, DB_FILE);
    const booksDir = path.join(rootDir, 'books');
    const booksStat = await stat(booksDir).catch(() => null);
    if (!existsSync(dbPath) || !booksStat?.isDirectory()) {
      throw new Error(`Not a Novel Engine data folder: expected ${DB_FILE} and a books folder in ${rootDir}`);
    }

    const tmpDir = await mkdtemp(path.join(tmpRoot, 'novel-engine-import-'));
    let db: DatabaseService | null = null;
    try {
      const copy = path.join(tmpDir, DB_FILE);
      await copyFile(dbPath, copy);
      if (existsSync(dbPath + '-wal')) await copyFile(dbPath + '-wal', copy + '-wal');

      const schemaVersion = readSchemaVersion(copy);
      db = new DatabaseService(copy);
      const opened = db;

      return {
        rootDir,
        booksDir,
        db: opened,
        schemaVersion,
        close: async () => {
          opened.close();
          await rm(tmpDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      db?.close();
      await rm(tmpDir, { recursive: true, force: true });
      throw err;
    }
  };
}

/** schema_version before migration; -1 for a DB that predates version tracking. */
function readSchemaVersion(file: string): number {
  const raw = new Database(file, { fileMustExist: true });
  try {
    const hasTable = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    if (!hasTable) return -1;
    return (raw.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number | null }).v ?? -1;
  } finally {
    raw.close();
  }
}
