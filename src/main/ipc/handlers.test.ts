import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataFolderInfo } from '@domain/types';
import { PUSH_CHANNELS } from '@domain/channels';
import { registerIpcHandlers } from './handlers';
import { ChannelRouter } from './router';
import { readPointer } from '../dataLocation';
import { makeFakeAgents, makeFakeSettings, type FakeSettings } from '../../test/fakes';
import { makeFakeContext, makeFakeEvents, makeFakeHost, type FakeEvents, type FakeHost } from '../../test/fakeHost';
import { cleanupTempDirs, makeTempDir } from '../../test/tempDir';

/**
 * Handlers are thin adapters — these tests verify WIRING (registration,
 * arg forwarding, result/error passthrough), not business logic. Services
 * are recording fakes; any method not explicitly stubbed resolves undefined.
 * The platform is a fake `HostAdapter` and `EventSink`: nothing here touches Electron.
 */

type AnyFn = ReturnType<typeof vi.fn>;
type ServiceFake = Record<string, AnyFn>;

/** Recording service fake: every method is a memoized vi.fn resolving undefined. */
function auto(impl: Record<string, AnyFn> = {}): ServiceFake {
  const fns = new Map<PropertyKey, AnyFn>(Object.entries(impl));
  return new Proxy({} as ServiceFake, {
    get(_target, prop) {
      if (!fns.has(prop)) fns.set(prop, vi.fn(async () => undefined));
      return fns.get(prop);
    },
  });
}

let userDataPath: string;
let dataFolderInfo: DataFolderInfo;
let settings: FakeSettings;
let svc: Record<string, ServiceFake>;
let hooks: { onActiveBookChanged: ReturnType<typeof vi.fn<(slug: string) => void>> };
let router: ChannelRouter;
let host: FakeHost;
let events: FakeEvents;
let ctx: ReturnType<typeof makeFakeContext>;

const invoke = (channel: string, ...args: unknown[]): unknown => router.dispatch(channel, ctx, args);

beforeEach(async () => {
  vi.clearAllMocks();
  userDataPath = await makeTempDir();
  dataFolderInfo = { current: userDataPath, defaultDir: userDataPath, source: 'default' };
  host = makeFakeHost();
  events = makeFakeEvents();
  ctx = makeFakeContext();
  router = new ChannelRouter();

  settings = makeFakeSettings({ authorName: 'Jane Author' });
  svc = {
    settings: settings as unknown as ServiceFake,
    agents: makeFakeAgents() as unknown as ServiceFake,
    db: auto(), fs: auto(), chat: auto(), audit: auto(), pipeline: auto(),
    build: auto(), usage: auto(), revisionQueue: auto(), motifLedger: auto(),
    notifications: auto(), version: auto(), providerRegistry: auto(),
    manuscriptImport: auto(), sourceGeneration: auto(), series: auto(),
    seriesImport: auto(), helper: auto(), findReplace: auto(),
    dashboard: auto(), statistics: auto(), query: auto(),
  };
  hooks = { onActiveBookChanged: vi.fn<(slug: string) => void>() };

  registerIpcHandlers(
    router,
    host,
    events,
    svc as unknown as Parameters<typeof registerIpcHandlers>[3],
    {
      userDataPath,
      booksDir: '/fake/books-dir',
      dataFolder: dataFolderInfo,
      promptSync: { updated: ['SPARK.md'], edited: ['QUILL.md'] },
    },
    hooks,
  );
});

afterEach(async () => {
  await cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('channel table', () => {
  const quoted = (source: string, call: string): string[] =>
    [...source.matchAll(new RegExp(`${call}\\(\\s*'([^']+)'`, 'g'))].map((m) => m[1]);

  it('matches the preload bridge exactly: every invoke/send has a route and every route has a caller', async () => {
    const preloadSource = await readFile(new URL('../../preload/index.ts', import.meta.url), 'utf-8');
    const table = router.table();
    const invoked = quoted(preloadSource, 'ipcRenderer\\.invoke');
    const sent = quoted(preloadSource, 'ipcRenderer\\.send');

    const routed = (kind: 'invoke' | 'send') => table.filter((r) => r.kind === kind).map((r) => r.channel).sort();
    expect(routed('invoke'), 'invoke routes vs preload invoke()').toEqual([...new Set(invoked)].sort());
    expect(routed('send'), 'send routes vs preload send()').toEqual([...new Set(sent)].sort());
  });

  it('push channels match the events the preload bridge subscribes to', async () => {
    const preloadSource = await readFile(new URL('../../preload/index.ts', import.meta.url), 'utf-8');
    const subscribed = [...new Set(quoted(preloadSource, 'ipcRenderer\\.on'))].sort();
    expect(subscribed).toEqual([...PUSH_CHANNELS].sort());
  });

  it('every route follows the namespace:action pattern and no channel is both a route and a push event', () => {
    for (const { channel } of router.table()) {
      expect(channel).toMatch(/^[a-zA-Z-]+:[a-zA-Z]+$/);
      expect((PUSH_CHANNELS as readonly string[]).includes(channel), channel).toBe(false);
    }
  });

  it('refuses to register a channel twice', () => {
    expect(() => router.handle('settings:load', () => null)).toThrow(/twice/);
  });
});

describe('settings namespace', () => {
  it('settings:load passes the settings object through', async () => {
    expect(await invoke('settings:load')).toEqual(settings.current);
  });

  it('settings:update syncs the host theme only when theme is present', async () => {
    await invoke('settings:update', { fontSize: 14 });
    expect(host.setTheme).not.toHaveBeenCalled();

    await invoke('settings:update', { theme: 'dark' });
    expect(host.setTheme).toHaveBeenLastCalledWith('dark');
    expect(settings.current.theme).toBe('dark');

    await invoke('settings:update', { theme: 'system' });
    expect(host.setTheme).toHaveBeenLastCalledWith('system');
  });

  it('author profile round-trips through the real userData path, empty when missing', async () => {
    expect(await invoke('settings:loadAuthorProfile')).toBe('');
    await invoke('settings:saveAuthorProfile', 'My writing voice.');
    expect(await invoke('settings:loadAuthorProfile')).toBe('My writing voice.');
  });
});

describe('agents namespace', () => {
  it('agents:list strips systemPrompt from every agent', async () => {
    const result = (await invoke('agents:list')) as Record<string, unknown>[];
    expect(result.length).toBeGreaterThan(0);
    for (const meta of result) {
      expect(meta).toHaveProperty('name');
      expect(meta).toHaveProperty('filename');
      expect(meta).not.toHaveProperty('systemPrompt');
    }
  });
});

describe('books namespace', () => {
  it('books:create injects the configured author name and fires the active-book hook', async () => {
    svc.fs.createBook.mockResolvedValue({ slug: 'new-book', title: 'My Title' });

    const result = await invoke('books:create', 'My Title');

    expect(svc.fs.createBook).toHaveBeenCalledWith('My Title', 'Jane Author');
    expect(hooks.onActiveBookChanged).toHaveBeenCalledWith('new-book');
    expect(result).toEqual({ slug: 'new-book', title: 'My Title' });
  });

  it('books:updateMeta migrates conversations and refires the hook only on slug change', async () => {
    svc.fs.updateBookMeta.mockResolvedValue({ slug: 'old-slug', title: 'Same' });
    await invoke('books:updateMeta', 'old-slug', { title: 'Same' });
    expect(svc.db.updateBookSlug).not.toHaveBeenCalled();
    expect(hooks.onActiveBookChanged).not.toHaveBeenCalled();

    svc.fs.updateBookMeta.mockResolvedValue({ slug: 'new-slug', title: 'Renamed' });
    await invoke('books:updateMeta', 'old-slug', { title: 'Renamed' });
    expect(svc.db.updateBookSlug).toHaveBeenCalledWith('old-slug', 'new-slug');
    expect(hooks.onActiveBookChanged).toHaveBeenCalledWith('new-slug');
  });

  it('books:uploadCover returns null on a canceled dialog and saves the picked file', async () => {
    expect(await invoke('books:uploadCover', 'book-a')).toBeNull();
    expect(svc.fs.saveCoverImage).not.toHaveBeenCalled();

    host.pickFiles.mockResolvedValue(['/tmp/cover.png']);
    await invoke('books:uploadCover', 'book-a');
    expect(svc.fs.saveCoverImage).toHaveBeenCalledWith('book-a', '/tmp/cover.png');
    // The picker is parented to the caller's window
    expect(host.pickFiles.mock.calls[0][1]).toBe(ctx);
  });

  it('books:getAbsolutePath delegates to the filesystem service', async () => {
    svc.fs.getAbsolutePath.mockReturnValue('/fake/books-dir/book-a/chapters/01/draft.md');
    expect(await invoke('books:getAbsolutePath', 'book-a', 'chapters/01/draft.md')).toBe(
      '/fake/books-dir/book-a/chapters/01/draft.md',
    );
    expect(svc.fs.getAbsolutePath).toHaveBeenCalledWith('book-a', 'chapters/01/draft.md');
  });
});

describe('shell namespace', () => {
  it('shell:openExternal opens https: and mailto: links only', async () => {
    await invoke('shell:openExternal', 'https://example.com/a');
    await invoke('shell:openExternal', 'mailto:someone@example.com');
    expect(host.openExternal).toHaveBeenCalledTimes(2);

    for (const url of ['http://example.com', 'file:///etc/hosts', 'smb://host/share', 'not a url']) {
      await expect(Promise.resolve().then(() => invoke('shell:openExternal', url)), url).rejects.toThrow();
    }
    expect(host.openExternal).toHaveBeenCalledTimes(2);
  });

  it('shell:openPath opens paths inside the books folder', async () => {
    await invoke('shell:openPath', path.join('/fake/books-dir', 'book-a', 'dist'));
    expect(host.openPath).toHaveBeenCalledWith(path.join('/fake/books-dir', 'book-a', 'dist'));
  });

  it('shell:openPath refuses relative paths and paths outside the books folder', async () => {
    for (const target of ['relative/file.md', '/etc/hosts', '/fake/books-dir/../elsewhere', '/fake/books-dir-other/x']) {
      await expect(Promise.resolve().then(() => invoke('shell:openPath', target)), target).rejects.toThrow();
    }
    expect(host.openPath).not.toHaveBeenCalled();
  });

  it('shell:openPath opens an export the user saved this session', async () => {
    const target = path.join(userDataPath, 'book-a-build.zip');
    expect(() => invoke('shell:openPath', target)).toThrow();

    const distDir = await makeTempDir();
    svc.fs.getAbsolutePath.mockReturnValue(distDir);
    svc.fs.getBookMeta.mockResolvedValue({ title: 'Book A' });
    host.saveFile.mockResolvedValue(target);
    expect(await invoke('build:exportZip', 'book-a')).toBe(target);
    expect(svc.fs.getAbsolutePath).toHaveBeenCalledWith('book-a', 'dist');

    await invoke('shell:openPath', target);
    expect(host.openPath).toHaveBeenCalledWith(target);
  });
});

describe('files + versions namespaces', () => {
  it('files:write writes then auto-snapshots as a user version, tolerating snapshot failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    svc.version.snapshotContent.mockRejectedValue(new Error('db closed'));

    await invoke('files:write', 'book-a', 'notes.md', 'content');

    expect(svc.fs.writeFile).toHaveBeenCalledWith('book-a', 'notes.md', 'content');
    expect(svc.version.snapshotContent).toHaveBeenCalledWith('book-a', 'notes.md', 'content', 'user');
    expect(warn).toHaveBeenCalled();
  });

  it('files:write takes no snapshot when the write is refused (#83)', async () => {
    svc.fs.writeFile.mockRejectedValue(new Error('Not a text file: assets/cover.png in book "book-a" was left unchanged'));

    await expect(Promise.resolve(invoke('files:write', 'book-a', 'assets/cover.png', 'text'))).rejects.toThrow(
      'Not a text file',
    );
    expect(svc.version.snapshotContent).not.toHaveBeenCalled();
  });

  it('service errors propagate to the caller as rejections', async () => {
    svc.fs.readFile.mockRejectedValue(new Error('File not found: notes.md in book "book-a"'));
    await expect(Promise.resolve(invoke('files:read', 'book-a', 'notes.md'))).rejects.toThrow(
      'File not found: notes.md in book "book-a"',
    );
  });

  it('versions:revert broadcasts chat:filesChanged and returns the version', async () => {
    svc.version.revertToVersion.mockResolvedValue({ id: 7 });

    const result = await invoke('versions:revert', 'book-a', 'draft.md', 7);

    expect(svc.version.revertToVersion).toHaveBeenCalledWith('book-a', 'draft.md', 7);
    expect(events.broadcast).toHaveBeenCalledWith('chat:filesChanged', ['draft.md'], 'book-a');
    expect(result).toEqual({ id: 7 });
  });
});

describe('thin adapters', () => {
  it('forward args and pass results through untouched', async () => {
    svc.usage.getSummary.mockReturnValue({ totalInputTokens: 1 });
    expect(await invoke('usage:summary', 'book-a')).toEqual({ totalInputTokens: 1 });
    expect(svc.usage.getSummary).toHaveBeenCalledWith('book-a');

    await invoke('pipeline:confirmAdvancement', 'book-a', 'pitch');
    expect(svc.pipeline.confirmPhaseAdvancement).toHaveBeenCalledWith('book-a', 'pitch');

    await invoke('query:updateTargetStatus', 'book-a', 't1', 'submitted', '2026-07-18');
    expect(svc.query.updateTargetStatus).toHaveBeenCalledWith('book-a', 't1', 'submitted', '2026-07-18');

    await invoke('shell:openExternal', 'https://example.com');
    expect(host.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('pitchRoom:discard deletes the draft and its conversation', async () => {
    await invoke('pitchRoom:discard', 'conv-1');
    expect(svc.fs.deletePitchDraft).toHaveBeenCalledWith('conv-1');
    expect(svc.db.deleteConversation).toHaveBeenCalledWith('conv-1');
  });

  it('books:findTitleConflict and import:seriesCheckTitles delegate the title checks (#79)', async () => {
    const conflict = { slug: 'twin', title: 'Twin', archived: false };
    svc.fs.findTitleConflict.mockResolvedValue(conflict);
    expect(await invoke('books:findTitleConflict', 'Twin')).toEqual(conflict);
    expect(svc.fs.findTitleConflict).toHaveBeenCalledWith('Twin');

    const volumes = [{ volumeNumber: 1, title: 'Twin' }];
    svc.seriesImport.checkTitles.mockResolvedValue([{ volumeNumber: 1, message: 'taken' }]);
    expect(await invoke('import:seriesCheckTitles', volumes)).toEqual([{ volumeNumber: 1, message: 'taken' }]);
    expect(svc.seriesImport.checkTitles).toHaveBeenCalledWith(volumes);
  });

  it('pitchRoom:promote and pitches:restore pass a replacement title through, dropping non-strings', async () => {
    svc.fs.promotePitchToBook.mockResolvedValue({ slug: 'new-title' });
    svc.fs.restorePitch.mockResolvedValue({ slug: 'other-title' });

    await invoke('pitchRoom:promote', 'conv-1', 'New Title');
    expect(svc.fs.promotePitchToBook).toHaveBeenCalledWith('conv-1', 'New Title');
    await invoke('pitchRoom:promote', 'conv-1', { not: 'a string' });
    expect(svc.fs.promotePitchToBook).toHaveBeenLastCalledWith('conv-1', undefined);

    await invoke('pitches:restore', 'pitch-a', 'Other Title');
    expect(svc.fs.restorePitch).toHaveBeenCalledWith('pitch-a', 'Other Title');
    await invoke('pitches:restore', 'pitch-a');
    expect(svc.fs.restorePitch).toHaveBeenLastCalledWith('pitch-a', undefined);
    expect(hooks.onActiveBookChanged).toHaveBeenCalledWith('other-title');
  });
});

describe('chat:send orchestration', () => {
  const params = { agentName: 'Spark', message: 'hi', conversationId: 'conv-1', bookSlug: 'book-a', callId: 'call-1' };

  it('tags stream events, notifies completion with the book title, and snapshots changed files', async () => {
    svc.chat.sendMessage.mockImplementation(
      async ({ onEvent }: { onEvent: (e: Record<string, unknown>) => void }) => {
        onEvent({ type: 'textDelta', text: 'hello' });
        return { changedFiles: ['chapters/01/draft.md'] };
      },
    );
    svc.fs.getBookMeta.mockResolvedValue({ title: 'My Novel' });

    await invoke('chat:send', params);

    // Renderer-provided callId is preserved; events tagged for scoping
    const sendCall = svc.chat.sendMessage.mock.calls[0][0] as { callId: string };
    expect(sendCall.callId).toBe('call-1');
    expect(events.broadcast).toHaveBeenCalledWith('chat:streamEvent', {
      type: 'textDelta', text: 'hello', callId: 'call-1', conversationId: 'conv-1', source: 'chat',
    });
    expect(svc.notifications.notifyChatComplete).toHaveBeenCalledWith('Spark', 'My Novel');
    expect(svc.notifications.notifyChatError).not.toHaveBeenCalled();
    expect(events.broadcast).toHaveBeenCalledWith('chat:filesChanged', ['chapters/01/draft.md'], 'book-a');
    expect(svc.version.snapshotFile).toHaveBeenCalledWith('book-a', 'chapters/01/draft.md', 'agent');
    expect(svc.statistics.recordWordCountSnapshot).toHaveBeenCalledWith('book-a');
  });

  it('routes stream errors to the error notification instead', async () => {
    svc.chat.sendMessage.mockImplementation(
      async ({ onEvent }: { onEvent: (e: Record<string, unknown>) => void }) => {
        onEvent({ type: 'error', message: 'CLI crashed' });
        return { changedFiles: [] };
      },
    );

    await invoke('chat:send', params);

    expect(svc.notifications.notifyChatError).toHaveBeenCalledWith('Spark', 'CLI crashed');
    expect(svc.notifications.notifyChatComplete).not.toHaveBeenCalled();
    expect(svc.version.snapshotFile).not.toHaveBeenCalled();
  });
});

describe('hot-take:start', () => {
  it('creates a Ghostlight conversation, fires the stream, and returns the ids', async () => {
    svc.db.createConversation.mockImplementation((p: { id: string }) => p);
    svc.chat.sendMessage.mockImplementation(
      async ({ onEvent }: { onEvent: (e: Record<string, unknown>) => void }) => {
        onEvent({ type: 'textDelta', text: 'take' });
        return { changedFiles: [] };
      },
    );

    const result = (await invoke('hot-take:start', 'book-a')) as { conversationId: string; callId: string };

    const created = svc.db.createConversation.mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({ bookSlug: 'book-a', agentName: 'Ghostlight', purpose: 'hot-take', pipelinePhase: null });
    expect(result.conversationId).toBe(created.id);
    expect(result.callId).toBeTruthy();
    expect(events.broadcast).toHaveBeenCalledWith('chat:streamEvent', {
      type: 'textDelta', text: 'take', callId: result.callId, conversationId: result.conversationId, source: 'hot-take',
    });
  });
});

describe('verity namespace', () => {
  it('verity:auditChapter emits a synthetic callStart and forwards to the audit service', async () => {
    svc.audit.auditChapter.mockResolvedValue({ chapter: '01' });

    const result = await invoke('verity:auditChapter', 'book-a', '01-first', 'call-7', 'conv-7');

    expect(events.broadcast).toHaveBeenCalledWith('chat:streamEvent', {
      type: 'callStart', callId: 'call-7', conversationId: 'conv-7', agentName: 'Verity', model: 'unknown', bookSlug: 'book-a',
    });
    const auditCall = svc.audit.auditChapter.mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall).toMatchObject({ bookSlug: 'book-a', chapterSlug: '01-first', conversationId: 'conv-7' });
    expect(result).toEqual({ chapter: '01' });
  });
});

describe('revision queue event forwarding', () => {
  it('forwards queue events to the sink, re-tags stream events, and fires notifications', () => {
    const onQueueEvent = svc.revisionQueue.onEvent.mock.calls[0][0] as (event: Record<string, unknown>) => void;

    const streamEvent = {
      type: 'session:streamEvent', sessionId: 's1', conversationId: 'c1',
      event: { type: 'textDelta', text: 'revising' },
    };
    onQueueEvent(streamEvent);
    expect(events.broadcast).toHaveBeenCalledWith('revision:event', streamEvent);
    expect(events.broadcast).toHaveBeenCalledWith('chat:streamEvent', {
      type: 'textDelta', text: 'revising', callId: 'rev:s1', conversationId: 'c1', source: 'revision',
    });

    onQueueEvent({ type: 'session:done', taskNumbers: [1, 2] });
    expect(svc.notifications.notifyRevisionSessionComplete).toHaveBeenCalledWith('Session finished (tasks 1, 2)');

    onQueueEvent({ type: 'queue:done' });
    expect(svc.notifications.notifyRevisionQueueDone).toHaveBeenCalled();
  });
});

describe('data folder and prompt sync (#39)', () => {
  it('agents:promptSync returns the launch result and the agents folder', () => {
    expect(invoke('agents:promptSync')).toEqual({
      updated: ['SPARK.md'],
      edited: ['QUILL.md'],
      agentsDir: path.join(userDataPath, 'custom-agents'),
    });
  });

  it('dataFolder:get returns the resolved folder info', () => {
    expect(invoke('dataFolder:get')).toEqual(dataFolderInfo);
  });

  it('dataFolder:change writes the pointer and relaunches after confirm', async () => {
    const target = await makeTempDir();
    host.pickFiles.mockResolvedValue([target]);
    host.confirm.mockResolvedValue(0);

    await expect(invoke('dataFolder:change')).resolves.toBe(true);
    expect(readPointer(userDataPath)).toEqual({ dataDir: target, confirmed: true });
    expect(host.relaunch).toHaveBeenCalled();
  });

  it('dataFolder:change does nothing when the picker is cancelled', async () => {
    await expect(invoke('dataFolder:change')).resolves.toBe(false);
    expect(readPointer(userDataPath)).toBeNull();
    expect(host.relaunch).not.toHaveBeenCalled();
  });

  it('dataFolder:change and reset refuse while a flag or env override is active', async () => {
    dataFolderInfo.source = 'env';
    await expect(invoke('dataFolder:change')).resolves.toBe(false);
    await expect(invoke('dataFolder:reset')).resolves.toBe(false);
    expect(host.pickFiles).not.toHaveBeenCalled();
    expect(host.relaunch).not.toHaveBeenCalled();
  });

  it('dataFolder:reset points back at the default after confirm', async () => {
    dataFolderInfo.source = 'pointer';
    dataFolderInfo.current = '/elsewhere';
    host.confirm.mockResolvedValue(0);

    await expect(invoke('dataFolder:reset')).resolves.toBe(true);
    expect(readPointer(userDataPath)).toEqual({ dataDir: null, confirmed: true });
    expect(host.relaunch).toHaveBeenCalled();
  });
});
