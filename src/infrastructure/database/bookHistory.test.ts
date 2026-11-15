import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseService } from './DatabaseService';
import { makeDb, makeConversation, makeMessage, makeUsage, makeFileVersion } from '../../test/db';
import { makeTempDir, cleanupTempDirs } from '../../test/tempDir';
import { APP_SCHEMA_VERSION } from './bookHistory';

let source: DatabaseService;
let target: DatabaseService;
let dir: string;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  source = makeDb();
  target = makeDb();
  dir = await makeTempDir();
});

afterEach(async () => {
  source.close();
  target.close();
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

/** Seed two books plus pitch-room noise in the source DB. */
function seed() {
  const a1 = makeConversation(source, { id: 'a-1', bookSlug: 'book-a', title: 'first' });
  const a2 = makeConversation(source, { id: 'a-2', bookSlug: 'book-a', agentName: 'Verity' });
  makeMessage(source, a1.id, { content: 'hello a', thinking: 'hmm' });
  makeMessage(source, a1.id, { role: 'assistant', content: 'reply a' });
  makeMessage(source, a2.id, { content: 'second convo' });
  makeUsage(source, a1.id, { inputTokens: 7 });
  makeFileVersion(source, { bookSlug: 'book-a', filePath: 'chapters/01/draft.md', content: 'v1' });
  makeFileVersion(source, { bookSlug: 'book-a', filePath: 'chapters/01/draft.md', content: 'v2 longer', source: 'agent' });
  source.recordWordCountSnapshot('book-a', 1200, 3);

  const b1 = makeConversation(source, { id: 'b-1', bookSlug: 'book-b' });
  makeMessage(source, b1.id, { content: 'other book' });
  makeFileVersion(source, { bookSlug: 'book-b', content: 'not mine' });
  source.recordWordCountSnapshot('book-b', 99, 1);

  const p = makeConversation(source, { id: 'p-1', bookSlug: '__pitch-room__' });
  makeMessage(source, p.id, { content: 'pitch' });
}

describe('book history snapshots', () => {
  it('exports only the chosen book and merges it under a new slug', () => {
    seed();
    const file = path.join(dir, 'history.sqlite');

    const exported = source.exportBookHistory('book-a', file);
    expect(exported).toEqual({ conversations: 2, messages: 3, tokenUsage: 1, fileVersions: 2, wordCountSnapshots: 1 });

    // Pre-existing target rows get lower ids than the merged rows.
    makeFileVersion(target, { bookSlug: 'existing', content: 'x' });
    target.recordWordCountSnapshot('existing', 5, 1);

    const receipt = target.importBookHistory(file, 'renamed-a');
    expect(receipt.counts).toEqual(exported);
    expect(receipt.conversationIds.sort()).toEqual(['a-1', 'a-2']);

    const convs = target.listConversations('renamed-a');
    expect(convs.map((c) => c.id).sort()).toEqual(['a-1', 'a-2']);
    expect(convs.find((c) => c.id === 'a-1')).toMatchObject({
      title: source.getConversation('a-1')?.title,
      createdAt: source.getConversation('a-1')?.createdAt,
      agentName: 'Spark',
    });
    expect(target.listConversations('book-a')).toEqual([]);

    const msgs = target.getMessages('a-1');
    expect(msgs.map((m) => m.content).sort()).toEqual(['hello a', 'reply a']);
    expect(msgs.find((m) => m.content === 'hello a')?.thinking).toBe('hmm');
    expect(target.getUsageByConversation('a-1')[0].inputTokens).toBe(7);

    const versions = target.listFileVersions('renamed-a', 'chapters/01/draft.md', 10, 0);
    expect(versions).toHaveLength(2);
    expect(versions[0].source).toBe('agent'); // newest first: order preserved
    expect(target.getFileVersion(versions[0].id)?.content).toBe('v2 longer');

    expect(target.getWordCountHistory('renamed-a').map((s) => s.wordCount)).toEqual([1200]);
    expect(target.getWordCountHistory('existing')).toHaveLength(1);
  });

  it('refuses to overwrite an existing snapshot file', () => {
    seed();
    const file = path.join(dir, 'history.sqlite');
    source.exportBookHistory('book-a', file);
    expect(() => source.exportBookHistory('book-a', file)).toThrow(/already exists/);
  });

  it('rolls back the whole merge on a conversation id clash', () => {
    seed();
    const file = path.join(dir, 'history.sqlite');
    source.exportBookHistory('book-a', file);
    makeConversation(target, { id: 'a-2', bookSlug: 'elsewhere' });

    expect(() => target.importBookHistory(file, 'book-a')).toThrow();
    expect(target.listConversations('book-a')).toEqual([]);
    expect(target.getVersionedFilePaths('book-a')).toEqual([]);
    expect(target.getWordCountHistory('book-a')).toEqual([]);
  });

  it('reverts a merge without touching other rows', () => {
    seed();
    const file = path.join(dir, 'history.sqlite');
    source.exportBookHistory('book-a', file);
    makeConversation(target, { id: 'keep', bookSlug: 'book-a' });
    makeFileVersion(target, { bookSlug: 'book-a', content: 'keep me' });

    const receipt = target.importBookHistory(file, 'book-a');
    target.revertBookHistoryImport(receipt);

    expect(target.listConversations('book-a').map((c) => c.id)).toEqual(['keep']);
    expect(target.getMessages('a-1')).toEqual([]);
    expect(target.getUsageByConversation('a-1')).toEqual([]);
    expect(target.countFileVersions('book-a', 'source/pitch.md')).toBe(1);
    expect(target.countFileVersions('book-a', 'chapters/01/draft.md')).toBe(0);
    expect(target.getWordCountHistory('book-a')).toEqual([]);
  });

  it('refuses a snapshot from a newer schema', () => {
    seed();
    const file = path.join(dir, 'history.sqlite');
    source.exportBookHistory('book-a', file);
    const raw = new Database(file);
    raw.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)').run(
      APP_SCHEMA_VERSION + 1,
      'now',
      'future',
    );
    raw.close();

    expect(() => target.importBookHistory(file, 'book-a')).toThrow(/newer Novel Engine/);
    expect(target.listConversations('book-a')).toEqual([]);
  });

  it('rejects a file that is not a snapshot', () => {
    const file = path.join(dir, 'other.sqlite');
    const raw = new Database(file);
    raw.exec('CREATE TABLE foo (x)');
    raw.close();
    expect(() => target.importBookHistory(file, 'x')).toThrow(/Not a book history snapshot/);
  });

  it('exports an empty snapshot for a book with no history', () => {
    const file = path.join(dir, 'history.sqlite');
    const counts = source.exportBookHistory('nothing', file);
    expect(counts).toEqual({ conversations: 0, messages: 0, tokenUsage: 0, fileVersions: 0, wordCountSnapshots: 0 });
    expect(target.importBookHistory(file, 'nothing').counts.conversations).toBe(0);
  });

  it('reports history stats, existing ids and schema version', () => {
    seed();
    const stats = source.getBookHistoryStats('book-a');
    expect(stats.conversationCount).toBe(2);
    // versions (2 + 9) + message text (7 + 3 + 7 + 12)
    expect(stats.historyBytes).toBe(2 + 9 + 'hello a'.length + 'hmm'.length + 'reply a'.length + 'second convo'.length);
    expect(source.findExistingConversationIds(['a-1', 'zzz', 'b-1']).sort()).toEqual(['a-1', 'b-1']);
    expect(source.findExistingConversationIds([])).toEqual([]);
    expect(source.listConversationIds('book-b')).toEqual(['b-1']);
    expect(source.getSchemaVersion()).toBe(APP_SCHEMA_VERSION);
  });
});
