import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIGRATION_BACKUPS_KEPT,
  MigrationBackupError,
  backupBeforeMigrations,
  migrationBackupFileName,
  pruneMigrationBackups,
} from './backup';
import { DatabaseService } from './DatabaseService';
import { APP_SCHEMA_VERSION, readAppliedVersion } from './migrations';

let dir: string;
let dbPath: string;
let backupDir: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  dir = mkdtempSync(path.join(tmpdir(), 'ne-backup-test-'));
  dbPath = path.join(dir, 'novel-engine.db');
  backupDir = path.join(dir, 'backups');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A file DB at schema `version` (null = untracked) with one conversation row and no `purpose` column. */
function seedLegacyDb(version: number | null): void {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, book_slug TEXT NOT NULL, agent_name TEXT NOT NULL, pipeline_phase TEXT,
      title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO conversations (id, book_slug, agent_name) VALUES ('c1', 'book', 'Spark');
  `);
  if (version !== null) {
    raw.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT NOT NULL DEFAULT '')`);
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  raw.close();
}

function backups(): string[] {
  return readdirSync(backupDir).sort();
}

describe('migrationBackupFileName', () => {
  it('names from/to versions and a filesystem-safe timestamp', () => {
    const now = new Date('2026-11-20T15:30:12.345Z');
    expect(migrationBackupFileName(2, 4, now)).toBe('novel-engine-pre-v2-to-v4-2026-11-20T15-30-12-345Z.db');
    expect(migrationBackupFileName(-1, 4, now)).toBe('novel-engine-pre-unversioned-to-v4-2026-11-20T15-30-12-345Z.db');
  });
});

describe('backupBeforeMigrations', () => {
  it('writes a consistent copy of the pre-migration DB when migrations are pending', () => {
    seedLegacyDb(0);
    const db = new Database(dbPath);
    const file = backupBeforeMigrations(db, backupDir, new Date('2026-11-20T00:00:00.000Z'));
    db.close();

    expect(file).toBe(path.join(backupDir, `novel-engine-pre-v0-to-v${APP_SCHEMA_VERSION}-2026-11-20T00-00-00-000Z.db`));
    const copy = new Database(file!, { readonly: true });
    expect(readAppliedVersion(copy)).toBe(0);
    expect(copy.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'c1' }]);
    copy.close();
  });

  it('includes rows still in the WAL of another open connection', () => {
    seedLegacyDb(0);
    const other = new Database(dbPath); // e.g. upstream app sharing the folder
    other.pragma('journal_mode = WAL');
    other.pragma('wal_autocheckpoint = 0');
    other.prepare(`INSERT INTO conversations (id, book_slug, agent_name) VALUES ('c2', 'book', 'Verity')`).run();

    const db = new Database(dbPath);
    const file = backupBeforeMigrations(db, backupDir);
    db.close();
    other.close();

    const copy = new Database(file!, { readonly: true });
    expect(copy.prepare('SELECT id FROM conversations ORDER BY id').all()).toEqual([{ id: 'c1' }, { id: 'c2' }]);
    copy.close();
  });

  it('backs up a DB that predates version tracking', () => {
    seedLegacyDb(null);
    const db = new Database(dbPath);
    const file = backupBeforeMigrations(db, backupDir);
    db.close();
    expect(path.basename(file!)).toMatch(/^novel-engine-pre-unversioned-to-v\d+-/);
  });

  it('writes nothing when no migrations are pending', () => {
    seedLegacyDb(APP_SCHEMA_VERSION);
    const db = new Database(dbPath);
    expect(backupBeforeMigrations(db, backupDir)).toBeNull();
    db.close();
    expect(() => readdirSync(backupDir)).toThrow(); // folder never created
  });

  it('writes nothing for a brand-new empty DB', () => {
    const db = new Database(dbPath);
    expect(backupBeforeMigrations(db, backupDir)).toBeNull();
    db.close();
  });

  it(`keeps only the newest ${MIGRATION_BACKUPS_KEPT} snapshots`, () => {
    seedLegacyDb(0);
    const db = new Database(dbPath);
    for (let day = 1; day <= 5; day++) {
      backupBeforeMigrations(db, backupDir, new Date(`2026-11-0${day}T00:00:00.000Z`));
    }
    db.close();

    expect(backups()).toEqual([
      `novel-engine-pre-v0-to-v${APP_SCHEMA_VERSION}-2026-11-03T00-00-00-000Z.db`,
      `novel-engine-pre-v0-to-v${APP_SCHEMA_VERSION}-2026-11-04T00-00-00-000Z.db`,
      `novel-engine-pre-v0-to-v${APP_SCHEMA_VERSION}-2026-11-05T00-00-00-000Z.db`,
    ]);
  });

  it('throws MigrationBackupError when the snapshot cannot be written', () => {
    seedLegacyDb(0);
    writeFileSync(backupDir, 'not a folder'); // mkdir fails
    const db = new Database(dbPath);
    expect(() => backupBeforeMigrations(db, backupDir)).toThrow(MigrationBackupError);
    db.close();
  });
});

describe('pruneMigrationBackups', () => {
  it('sorts by timestamp, not by version label, and ignores other files', () => {
    mkdirSync(backupDir);
    const names = [
      'novel-engine-pre-v9-to-v10-2026-01-01T00-00-00-000Z.db', // oldest despite high version
      'novel-engine-pre-v1-to-v2-2026-02-01T00-00-00-000Z.db',
      'novel-engine-pre-v1-to-v2-2026-03-01T00-00-00-000Z.db',
      'notes.txt',
    ];
    for (const n of names) writeFileSync(path.join(backupDir, n), '');

    expect(pruneMigrationBackups(backupDir, 2)).toEqual([names[0]]);
    expect(backups()).toEqual([names[1], names[2], 'notes.txt'].sort());
  });
});

describe('DatabaseService with migrationBackupDir', () => {
  it('snapshots before migrating, and the live DB is migrated', () => {
    seedLegacyDb(0);
    const svc = new DatabaseService(dbPath, { migrationBackupDir: backupDir });
    svc.close();

    expect(backups()).toHaveLength(1);
    const copy = new Database(path.join(backupDir, backups()[0]), { readonly: true });
    expect(readAppliedVersion(copy)).toBe(0);
    copy.close();

    const live = new Database(dbPath, { readonly: true });
    expect(readAppliedVersion(live)).toBe(APP_SCHEMA_VERSION);
    live.close();
  });

  it('writes no snapshot on a second open (nothing pending)', () => {
    seedLegacyDb(0);
    new DatabaseService(dbPath, { migrationBackupDir: backupDir }).close();
    new DatabaseService(dbPath, { migrationBackupDir: backupDir }).close();
    expect(backups()).toHaveLength(1);
  });

  it('does not migrate when the snapshot fails', () => {
    seedLegacyDb(0);
    writeFileSync(backupDir, 'not a folder');

    expect(() => new DatabaseService(dbPath, { migrationBackupDir: backupDir })).toThrow(MigrationBackupError);

    const live = new Database(dbPath, { readonly: true });
    expect(readAppliedVersion(live)).toBe(0);
    const cols = (live.pragma('table_info(conversations)') as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('purpose');
    live.close();
  });

  it('takes no snapshot without the option', () => {
    seedLegacyDb(0);
    new DatabaseService(dbPath).close();
    expect(() => readdirSync(backupDir)).toThrow();
  });
});
