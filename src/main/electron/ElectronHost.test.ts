import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, BrowserWindow, dialog, nativeTheme, Notification, shell } from 'electron';
import { ElectronEventSink } from './ElectronEventSink';
import { ElectronHost } from './ElectronHost';

vi.mock('electron', () => import('../../test/mocks/electron'));

const MockNotification = Notification as unknown as {
  isSupported: ReturnType<typeof vi.fn>;
  instances: { options: { title?: string; body?: string }; show: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[];
};

let host: ElectronHost;
let win: BrowserWindow;
const ctx = { sender: { id: 1 }, reply: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  MockNotification.instances.length = 0;
  host = new ElectronHost();
  win = new BrowserWindow();
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
  vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
});

describe('dialogs', () => {
  it('pickFiles maps options to dialog properties and returns null when cancelled', async () => {
    expect(await host.pickFiles({ title: 'Pick' })).toBeNull();

    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/a', '/b'] });
    expect(await host.pickFiles({ multiple: true })).toEqual(['/a', '/b']);
    expect(vi.mocked(dialog.showOpenDialog).mock.calls[1][0]).toMatchObject({ properties: ['openFile', 'multiSelections'] });

    await host.pickFiles({ directory: true, createDirectory: true });
    expect(vi.mocked(dialog.showOpenDialog).mock.calls[2][0]).toMatchObject({
      properties: ['openDirectory', 'createDirectory'],
    });
  });

  it('parents a dialog to the caller\'s window when there is one', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win);
    await host.pickFiles({}, ctx);
    expect(vi.mocked(dialog.showOpenDialog).mock.calls[0][0]).toBe(win);

    await host.confirm({ message: 'ok?' }, ctx);
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0][0]).toBe(win);
  });

  it('saveFile returns the chosen path or null', async () => {
    expect(await host.saveFile({})).toBeNull();
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/out.zip' });
    expect(await host.saveFile({})).toBe('/out.zip');
  });

  it('confirm returns the pressed button index', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false });
    expect(await host.confirm({ message: 'x', buttons: ['a', 'b', 'c'] })).toBe(2);
  });
});

describe('shell, theme and lifecycle', () => {
  it('delegates openExternal, openPath and setTheme', async () => {
    await host.openExternal('https://example.com');
    await host.openPath('/books/a');
    host.setTheme('dark');
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(shell.openPath).toHaveBeenCalledWith('/books/a');
    expect(nativeTheme.themeSource).toBe('dark');
  });

  it('relaunch restarts the app and exits', () => {
    host.relaunch();
    expect(app.relaunch).toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledWith(0);
    host.exit(1);
    expect(app.exit).toHaveBeenCalledWith(1);
  });
});

describe('notifications and focus', () => {
  it('reports support and focus from Electron', () => {
    expect(host.notificationsSupported()).toBe(true);
    expect(host.isFocused()).toBe(false);
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(win);
    expect(host.isFocused()).toBe(true);
  });

  it('shows a notification whose click restores a minimized window and focuses it', () => {
    vi.mocked(win.isMinimized).mockReturnValue(true);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win]);

    host.notify('Title', 'Body');

    const instance = MockNotification.instances[0];
    expect(instance.options).toEqual({ title: 'Title', body: 'Body' });
    expect(instance.show).toHaveBeenCalledTimes(1);
    const [event, onClick] = instance.on.mock.calls[0] as [string, () => void];
    expect(event).toBe('click');
    onClick();
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});

describe('window controls', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win);
  });

  it('minimizes, closes and toggles maximize on the caller\'s window', () => {
    host.windowControl('minimize', ctx);
    expect(win.minimize).toHaveBeenCalled();

    host.windowControl('maximize', ctx);
    expect(win.maximize).toHaveBeenCalled();
    vi.mocked(win.isMaximized).mockReturnValue(true);
    host.windowControl('maximize', ctx);
    expect(win.unmaximize).toHaveBeenCalled();
    expect(host.isWindowMaximized(ctx)).toBe(true);
  });

  it('does nothing when the caller has no window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    expect(() => host.windowControl('close', ctx)).not.toThrow();
    expect(host.isWindowMaximized(ctx)).toBe(false);
  });
});

describe('ElectronEventSink', () => {
  it('sends to every live window and skips destroyed ones', () => {
    const live = new BrowserWindow();
    const deadWebContents = new BrowserWindow();
    deadWebContents.webContents.isDestroyed = vi.fn((): boolean => true);
    const deadWindow = new BrowserWindow();
    vi.mocked(deadWindow.isDestroyed).mockReturnValue(true);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([live, deadWebContents, deadWindow]);

    new ElectronEventSink().broadcast('chat:filesChanged', ['a.md'], 'book-a');

    expect(live.webContents.send).toHaveBeenCalledWith('chat:filesChanged', ['a.md'], 'book-a');
    expect(deadWebContents.webContents.send).not.toHaveBeenCalled();
    expect(deadWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('keeps going when one window throws on send', () => {
    const closing = new BrowserWindow();
    closing.webContents.send = vi.fn(() => { throw new Error('Render frame was disposed'); });
    const live = new BrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([closing, live]);

    new ElectronEventSink().broadcast('books:changed');

    expect(live.webContents.send).toHaveBeenCalledWith('books:changed');
  });
});
