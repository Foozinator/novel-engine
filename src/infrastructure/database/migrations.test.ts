import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations';

let db: Database.Database;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function tableNames(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function conversationColumns(): string[] {
  return (db.pragma('table_info(conversations)') as { name: string }[]).map((c) => c.name);
}

describe('MIGRATIONS list', () => {
  it('versions are sequential integers starting at 0', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i));
  });
});

describe('runMigrations', () => {
  it('adds the purpose column to a legacy conversations table, preserving rows', () => {
    // Pre-state: schema from before the purpose column existed
    db.exec(`
      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        book_slug  TEXT NOT NULL,
        agent_name TEXT NOT NULL
      );
      INSERT INTO conversations (id, book_slug, agent_name) VALUES ('old', 'book', 'Spark');
    `);

    runMigrations(db);

    expect(conversationColumns()).toContain('purpose');
    const row = db
      .prepare(`SELECT id, purpose FROM conversations WHERE id = 'old'`)
      .get() as { id: string; purpose: string };
    expect(row.purpose).toBe('pipeline'); // default applied to pre-existing rows
  });

  it('leaves an existing purpose column untouched', () => {
    db.exec(`
      CREATE TABLE conversations (
        id      TEXT PRIMARY KEY,
        book_slug TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'pipeline'
      );
      INSERT INTO conversations (id, book_slug, agent_name, purpose) VALUES ('c', 'b', 'Spark', 'helper');
    `);

    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare(`SELECT purpose FROM conversations WHERE id = 'c'`).get() as { purpose: string };
    expect(row.purpose).toBe('helper');
  });

  it('creates the file_versions and word_count_snapshots tables', () => {
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT, agent_name TEXT);`);
    runMigrations(db);
    expect(tableNames()).toContain('file_versions');
    expect(tableNames()).toContain('word_count_snapshots');
  });

  it('adds cache-token and cost columns to an existing token_usage table, preserving rows', () => {
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT, agent_name TEXT);
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL
      );
      INSERT INTO token_usage (conversation_id, input_tokens, model) VALUES ('c1', 7, 'opus');
    `);
    runMigrations(db);

    const columns = (db.pragma('table_info(token_usage)') as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens', 'cost_usd']));
    expect(db.prepare('SELECT input_tokens, cache_read_tokens, cache_write_tokens, cost_usd FROM token_usage').get())
      .toEqual({ input_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null });
  });

  it('skips the token_usage columns when they already exist', () => {
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT, agent_name TEXT);
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL);
    `);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('records every applied version and is a no-op when re-run', () => {
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT, agent_name TEXT);`);
    runMigrations(db);

    const versions = (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
    ).map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));

    runMigrations(db); // second run must apply nothing
    const count = db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
  });

  it('applies only migrations newer than the recorded version', () => {
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT, agent_name TEXT, purpose TEXT);
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        description TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO schema_version (version) VALUES (2);
    `);

    runMigrations(db);

    // v3 applied, nothing below re-applied
    expect(tableNames()).toContain('word_count_snapshots');
    expect(tableNames()).not.toContain('file_versions');
  });

  it('rewrites \\ in file_versions paths to / and keeps row ids (v5)', () => {
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        description TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO schema_version (version) VALUES (4);
      CREATE TABLE file_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, book_slug TEXT NOT NULL, file_path TEXT NOT NULL);
    `);
    const insert = db.prepare('INSERT INTO file_versions (book_slug, file_path) VALUES (?, ?)');
    insert.run('b', 'chapters\\01-a\\draft.md');
    insert.run('b', 'chapters/01-a/draft.md');
    insert.run('b', 'about.json');
    insert.run('b', 'chapters\\01-a\\draft.md');

    runMigrations(db);

    expect(db.prepare('SELECT id, file_path FROM file_versions ORDER BY id').all()).toEqual([
      { id: 1, file_path: 'chapters/01-a/draft.md' },
      { id: 2, file_path: 'chapters/01-a/draft.md' },
      { id: 3, file_path: 'about.json' },
      { id: 4, file_path: 'chapters/01-a/draft.md' },
    ]);
  });
});
