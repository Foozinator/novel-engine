import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { APP_SCHEMA_VERSION, readAppliedVersion } from './migrations';

/** Number of pre-migration snapshots kept in the backups folder. */
export const MIGRATION_BACKUPS_KEPT = 3;

const BACKUP_PREFIX = 'novel-engine-pre-';
// Timestamp is `Date.toISOString()` with `:` and `.` replaced by `-`, so names sort by time.
const BACKUP_PATTERN = /^novel-engine-pre-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/;

/** The pre-migration snapshot could not be written. The DB was not migrated. */
export class MigrationBackupError extends Error {
  constructor(
    readonly backupDir: string,
    readonly reason: unknown,
  ) {
    super(
      `Could not back up the database before upgrading it, so the upgrade was not run.\n` +
        `Backup folder: ${backupDir}\n` +
        `Reason: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = 'MigrationBackupError';
  }
}

/** `novel-engine-pre-v<from>-to-v<to>-<timestamp>.db`; `from` is `unversioned` for -1. */
export function migrationBackupFileName(from: number, to: number, now: Date): string {
  const fromLabel = from < 0 ? 'unversioned' : `v${from}`;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${fromLabel}-to-v${to}-${stamp}.db`;
}

/**
 * Snapshot the database before schema migrations run (#58).
 *
 * Call on a freshly opened connection, before `initializeSchema`. Writes a
 * consistent single-file copy (WAL contents included) with `VACUUM INTO`,
 * then prunes to the newest `MIGRATION_BACKUPS_KEPT` snapshots.
 *
 * `VACUUM INTO` is used rather than better-sqlite3's `db.backup()` because the
 * latter is async and `DatabaseService` opens and migrates synchronously.
 *
 * Returns the snapshot path, or `null` when nothing is pending or the DB is
 * empty (a brand-new file has nothing to protect).
 * Throws `MigrationBackupError` if the snapshot can't be written; the caller
 * must not migrate.
 */
export function backupBeforeMigrations(
  db: Database.Database,
  backupDir: string,
  now: Date = new Date(),
): string | null {
  let from: number;
  try {
    from = readAppliedVersion(db);
  } catch (err) {
    throw new MigrationBackupError(backupDir, err);
  }
  if (from >= APP_SCHEMA_VERSION) return null;

  const hasTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (!hasTables) return null;

  const file = path.join(backupDir, migrationBackupFileName(from, APP_SCHEMA_VERSION, now));
  try {
    mkdirSync(backupDir, { recursive: true });
    db.prepare('VACUUM INTO ?').run(file);
  } catch (err) {
    try {
      rmSync(file, { force: true }); // drop a partial snapshot
    } catch {
      // Best effort — the folder itself may be what failed.
    }
    throw new MigrationBackupError(backupDir, err);
  }
  console.log(`[migrations] Backed up database to ${file}`);

  try {
    pruneMigrationBackups(backupDir, MIGRATION_BACKUPS_KEPT);
  } catch (err) {
    // The new snapshot exists; a failed prune only leaves extra files behind.
    console.warn('[migrations] Could not prune old database backups:', err);
  }
  return file;
}

/** Delete all but the newest `keep` snapshots. Other files in the folder are left alone. */
export function pruneMigrationBackups(backupDir: string, keep: number): string[] {
  const snapshots = readdirSync(backupDir)
    .map((name) => ({ name, stamp: BACKUP_PATTERN.exec(name)?.[1] }))
    .filter((s): s is { name: string; stamp: string } => s.stamp !== undefined)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  const removed = snapshots.slice(keep).map((s) => s.name);
  for (const name of removed) rmSync(path.join(backupDir, name), { force: true });
  return removed;
}
