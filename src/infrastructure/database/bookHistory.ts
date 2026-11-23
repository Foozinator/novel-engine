import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { BookHistoryCounts, BookHistoryImportReceipt } from '@domain/types';
import { APP_SCHEMA_VERSION } from './migrations';

export { APP_SCHEMA_VERSION };

/**
 * Per-book history snapshots.
 *
 * A snapshot is a small SQLite file holding one book's rows from the shared
 * DB: conversations, messages, token_usage, file_versions and
 * word_count_snapshots, plus a copy of schema_version. Stream tables are
 * transient and left out.
 *
 * #37 (import from another data folder) stages each book as its folder plus
 * a snapshot and then merges the snapshot. #36 archive/backup/unarchive will
 * put the same snapshot inside a zip.
 *
 * Columns are copied by name (the intersection of source and target), so a
 * snapshot from an older schema still merges; missing columns take their
 * defaults. A snapshot from a newer schema is refused.
 */

const H = 'book_history_snapshot';

function columnNames(db: Database.Database, schema: string, table: string): string[] {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema) as { name: string }[];
  return rows.map((r) => r.name);
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function withAttached<T>(db: Database.Database, file: string, fn: () => T): T {
  db.prepare(`ATTACH DATABASE ? AS ${H}`).run(file);
  try {
    return fn();
  } finally {
    db.prepare(`DETACH DATABASE ${H}`).run();
  }
}

export function exportBookHistory(db: Database.Database, bookSlug: string, destFile: string): BookHistoryCounts {
  if (existsSync(destFile)) {
    throw new Error(`History snapshot already exists: ${destFile}`);
  }
  return withAttached(db, destFile, () => {
    db.transaction(() => {
      db.prepare(`CREATE TABLE ${H}.conversations AS SELECT * FROM main.conversations WHERE book_slug = ?`).run(bookSlug);
      db.exec(`
        CREATE TABLE ${H}.messages AS SELECT * FROM main.messages
          WHERE conversation_id IN (SELECT id FROM ${H}.conversations);
        CREATE TABLE ${H}.token_usage AS SELECT * FROM main.token_usage
          WHERE conversation_id IN (SELECT id FROM ${H}.conversations);
        CREATE TABLE ${H}.schema_version AS SELECT * FROM main.schema_version;
      `);
      db.prepare(`CREATE TABLE ${H}.file_versions AS SELECT * FROM main.file_versions WHERE book_slug = ?`).run(bookSlug);
      db.prepare(`CREATE TABLE ${H}.word_count_snapshots AS SELECT * FROM main.word_count_snapshots WHERE book_slug = ?`).run(bookSlug);
    })();
    return countSnapshot(db);
  });
}

function countSnapshot(db: Database.Database): BookHistoryCounts {
  return {
    conversations: count(db, `SELECT COUNT(*) n FROM ${H}.conversations`),
    messages: count(db, `SELECT COUNT(*) n FROM ${H}.messages`),
    tokenUsage: count(db, `SELECT COUNT(*) n FROM ${H}.token_usage`),
    fileVersions: count(db, `SELECT COUNT(*) n FROM ${H}.file_versions`),
    wordCountSnapshots: count(db, `SELECT COUNT(*) n FROM ${H}.word_count_snapshots`),
  };
}

/** INSERT … SELECT for one table, copying shared columns and pinning book_slug. */
function mergeTable(
  db: Database.Database,
  table: string,
  opts: { dropId: boolean; slugColumn: boolean; targetSlug: string },
): void {
  const src = columnNames(db, H, table);
  const dst = new Set(columnNames(db, 'main', table));
  const cols = src.filter((c) => dst.has(c) && !(opts.dropId && c === 'id'));
  const exprs = cols.map((c) => (opts.slugColumn && c === 'book_slug' ? '@targetSlug' : `"${c}"`));
  const order = src.includes('id') ? ' ORDER BY id' : '';
  db.prepare(
    `INSERT INTO main.${table} (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${exprs.join(', ')} FROM ${H}.${table}${order}`,
  ).run(opts.slugColumn ? { targetSlug: opts.targetSlug } : {});
}

export function importBookHistory(db: Database.Database, srcFile: string, targetSlug: string): BookHistoryImportReceipt {
  if (!existsSync(srcFile)) {
    throw new Error(`History snapshot not found: ${srcFile}`);
  }
  return withAttached(db, srcFile, () => {
    const tables = new Set(
      (db.prepare(`SELECT name FROM ${H}.sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ['conversations', 'messages', 'token_usage', 'file_versions', 'word_count_snapshots', 'schema_version']) {
      if (!tables.has(t)) throw new Error(`Not a book history snapshot (missing ${t})`);
    }
    const srcVersion = (db.prepare(`SELECT MAX(version) v FROM ${H}.schema_version`).get() as { v: number | null }).v ?? -1;
    if (srcVersion > APP_SCHEMA_VERSION) {
      throw new Error(
        `This history was written by a newer Novel Engine (schema v${srcVersion}; this app supports up to v${APP_SCHEMA_VERSION}). Update the app first.`,
      );
    }

    const nextId = (table: string) => count(db, `SELECT COALESCE(MAX(id), 0) + 1 n FROM main.${table}`);

    return db.transaction((): BookHistoryImportReceipt => {
      const firstFileVersionId = nextId('file_versions');
      const firstWordCountSnapshotId = nextId('word_count_snapshots');

      mergeTable(db, 'conversations', { dropId: false, slugColumn: true, targetSlug });
      mergeTable(db, 'messages', { dropId: false, slugColumn: false, targetSlug });
      mergeTable(db, 'token_usage', { dropId: true, slugColumn: false, targetSlug });
      mergeTable(db, 'file_versions', { dropId: true, slugColumn: true, targetSlug });
      // A snapshot older than migration v5 can hold `\` paths (char(92)); store them with `/`.
      db.prepare(
        `UPDATE main.file_versions SET file_path = REPLACE(file_path, char(92), '/')
           WHERE book_slug = ? AND id >= ? AND instr(file_path, char(92)) > 0`,
      ).run(targetSlug, firstFileVersionId);
      mergeTable(db, 'word_count_snapshots', { dropId: true, slugColumn: true, targetSlug });

      const conversationIds = (db.prepare(`SELECT id FROM ${H}.conversations`).all() as { id: string }[]).map((r) => r.id);
      return {
        targetSlug,
        conversationIds,
        firstFileVersionId,
        firstWordCountSnapshotId,
        counts: countSnapshot(db),
      };
    })();
  });
}

export function revertBookHistoryImport(db: Database.Database, receipt: BookHistoryImportReceipt): void {
  const ids = JSON.stringify(receipt.conversationIds);
  db.transaction(() => {
    db.prepare('DELETE FROM token_usage WHERE conversation_id IN (SELECT value FROM json_each(?))').run(ids);
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?))').run(ids);
    db.prepare('DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?))').run(ids);
    db.prepare('DELETE FROM file_versions WHERE book_slug = ? AND id >= ?').run(receipt.targetSlug, receipt.firstFileVersionId);
    db.prepare('DELETE FROM word_count_snapshots WHERE book_slug = ? AND id >= ?').run(
      receipt.targetSlug,
      receipt.firstWordCountSnapshotId,
    );
  })();
}

export function findExistingConversationIds(db: Database.Database, ids: string[]): string[] {
  if (ids.length === 0) return [];
  return (
    db.prepare('SELECT id FROM conversations WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

export function listConversationIds(db: Database.Database, bookSlug: string): string[] {
  return (db.prepare('SELECT id FROM conversations WHERE book_slug = ?').all(bookSlug) as { id: string }[]).map((r) => r.id);
}

export function getBookHistoryStats(
  db: Database.Database,
  bookSlug: string,
): { conversationCount: number; historyBytes: number } {
  const conversationCount = count(db, 'SELECT COUNT(*) n FROM conversations WHERE book_slug = ?', bookSlug);
  const versionBytes = count(db, 'SELECT COALESCE(SUM(byte_size), 0) n FROM file_versions WHERE book_slug = ?', bookSlug);
  const messageBytes = count(
    db,
    `SELECT COALESCE(SUM(length(CAST(m.content AS BLOB)) + length(CAST(m.thinking AS BLOB))), 0) n
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.book_slug = ?`,
    bookSlug,
  );
  return { conversationCount, historyBytes: versionBytes + messageBytes };
}

export function getSchemaVersion(db: Database.Database): number {
  return (db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number | null }).v ?? -1;
}
