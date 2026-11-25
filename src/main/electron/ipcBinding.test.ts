import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { ChannelRouter } from '../ipc/router';
import { bindRouterToIpcMain } from './ipcBinding';

vi.mock('electron', () => import('../../test/mocks/electron'));

const APP_URL = 'app://novel-engine/index.html';

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function boundListeners(register: typeof ipcMain.handle | typeof ipcMain.on): Map<string, Listener> {
  return new Map(vi.mocked(register).mock.calls.map(([channel, listener]) => [channel, listener as Listener]));
}

const eventFrom = (url: string | undefined, sender: object = { isDestroyed: () => false, send: vi.fn() }) =>
  ({ sender, senderFrame: url === undefined ? null : { url } });

let router: ChannelRouter;
let seen: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  seen = [];
  router = new ChannelRouter();
  router.handle('files:read', (ctx, ...args) => { seen.push([ctx, ...args]); return 'content'; });
  router.on('window:close', (ctx) => { seen.push([ctx]); });
  bindRouterToIpcMain(router, (url) => url === APP_URL);
});

describe('bindRouterToIpcMain', () => {
  it('binds invoke routes to ipcMain.handle and send routes to ipcMain.on', () => {
    expect([...boundListeners(ipcMain.handle).keys()]).toEqual(['files:read']);
    expect([...boundListeners(ipcMain.on).keys()]).toEqual(['window:close']);
  });

  it('serves the app page and passes args and a context through', async () => {
    const sender = { isDestroyed: () => false, send: vi.fn() };
    const handler = boundListeners(ipcMain.handle).get('files:read')!;

    expect(await handler(eventFrom(APP_URL, sender), 'book-a', 'x.md')).toBe('content');
    const [ctx, ...args] = seen[0] as [{ sender: unknown; reply: (c: string, ...a: unknown[]) => void }, ...unknown[]];
    expect(args).toEqual(['book-a', 'x.md']);
    expect(ctx.sender).toBe(sender);

    ctx.reply('build:progress', 'step 1');
    expect(sender.send).toHaveBeenCalledWith('build:progress', 'step 1');
  });

  it('refuses a call from another page, or with no sender frame', () => {
    const handler = boundListeners(ipcMain.handle).get('files:read')!;
    expect(() => handler(eventFrom('https://example.com/'), 'a', 'b')).toThrow(/did not come from the app window/);
    expect(() => handler(eventFrom(undefined), 'a', 'b')).toThrow(/did not come from the app window/);
    expect(seen).toEqual([]);
  });

  it('drops fire-and-forget calls from another page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = boundListeners(ipcMain.on).get('window:close')!;
    handler(eventFrom('https://example.com/'));
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalled();

    handler(eventFrom(APP_URL));
    expect(seen).toHaveLength(1);
  });

  it('does not reply to a destroyed sender', () => {
    const sender = { isDestroyed: () => true, send: vi.fn() };
    boundListeners(ipcMain.handle).get('files:read')!(eventFrom(APP_URL, sender));
    const [ctx] = seen[0] as [{ reply: (c: string) => void }];
    ctx.reply('build:progress');
    expect(sender.send).not.toHaveBeenCalled();
  });
});
