import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from './DatabaseService';
import { makeSourceDataFolderOpener } from './SourceDataFolder';
import { APP_SCHEMA_VERSION } from './bookHistory';
import { makeConversation, makeMessage } from '../../test/db';
import { makeTempDir, cleanupTempDirs } from '../../test/tempDir';

async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return out;
}

let source: string;
let own: string;
let tmpRoot: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  source = await makeTempDir();
  own = await makeTempDir();
  tmpRoot = await makeTempDir();
  await mkdir(path.join(source, 'books'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe('makeSourceDataFolderOpener', () => {
  it('reads committed rows from a live WAL source and leaves it byte-for-byte unchanged', async () => {
    const live = new DatabaseService(path.join(source, 'novel-engine.db'));
    try {
      const c = makeConversation(live, { id: 'live-1', bookSlug: 'book-a' });
      makeMessage(live, c.id, { content: 'still in the WAL' });
      const before = await hashTree(source);
      expect(Object.keys(before)).toContain('novel-engine.db-wal');

      const open = makeSourceDataFolderOpener(own, tmpRoot);
      const snap = await open(source);
      expect(snap.booksDir).toBe(path.join(source, 'books'));
      expect(snap.schemaVersion).toBe(APP_SCHEMA_VERSION);
      expect(snap.db.listConversationIds('book-a')).toEqual(['live-1']);
      expect(snap.db.getMessages('live-1')[0].content).toBe('still in the WAL');
      await snap.close();

      expect(await hashTree(source)).toEqual(before);
      expect(await readdir(tmpRoot)).toEqual([]);
    } finally {
      live.close();
    }
  });

  it('migrates a pre-versioning source on the copy only', async () => {
    const file = path.join(source, 'novel-engine.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, book_slug TEXT NOT NULL, agent_name TEXT NOT NULL,
        pipeline_phase TEXT, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT NOT NULL DEFAULT '', timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, thinking_tokens INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO conversations (id, book_slug, agent_name) VALUES ('old-1', 'old-book', 'Spark');
    `);
    raw.close();
    const before = await hashTree(source);

    const snap = await makeSourceDataFolderOpener(own, tmpRoot)(source);
    expect(snap.schemaVersion).toBe(-1);
    expect(snap.db.getConversation('old-1')?.purpose).toBe('pipeline');
    expect(snap.db.getBookHistoryStats('old-book').conversationCount).toBe(1);
    await snap.close();

    expect(await hashTree(source)).toEqual(before);
  });

  it('refuses the app’s own data folder', async () => {
    new DatabaseService(path.join(source, 'novel-engine.db')).close();
    await expect(makeSourceDataFolderOpener(source, tmpRoot)(source)).rejects.toThrow(/own data folder/);
  });

  it('refuses a folder that is not a Novel Engine data folder', async () => {
    await expect(makeSourceDataFolderOpener(own, tmpRoot)(source)).rejects.toThrow(/Not a Novel Engine data folder/);
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
