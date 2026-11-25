import { app, BrowserWindow, dialog, nativeTheme, Notification, shell } from 'electron';
import type { WebContents } from 'electron';
import type {
  CallContext,
  ConfirmOptions,
  HostAdapter,
  PickFilesOptions,
  SaveFileOptions,
  WindowControl,
} from '../host';

/** The window that made a call, if it still exists. */
function windowOf(ctx: CallContext | null | undefined): BrowserWindow | null {
  const sender = ctx?.sender as WebContents | undefined;
  return sender ? BrowserWindow.fromWebContents(sender) : null;
}

/** `HostAdapter` for the desktop app: native dialogs, shell, theme, notifications. */
export class ElectronHost implements HostAdapter {
  async pickFiles(options: PickFilesOptions, ctx?: CallContext | null): Promise<string[] | null> {
    const properties: Electron.OpenDialogOptions['properties'] = options.directory
      ? ['openDirectory', ...(options.createDirectory ? (['createDirectory'] as const) : [])]
      : ['openFile', ...(options.multiple ? (['multiSelections'] as const) : [])];
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties,
    };
    const win = windowOf(ctx);
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return canceled || filePaths.length === 0 ? null : filePaths;
  }

  async saveFile(options: SaveFileOptions, ctx?: CallContext | null): Promise<string | null> {
    const win = windowOf(ctx);
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    return canceled || !filePath ? null : filePath;
  }

  async confirm(options: ConfirmOptions, ctx?: CallContext | null): Promise<number> {
    const win = windowOf(ctx);
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return response;
  }

  showError(title: string, message: string): void {
    dialog.showErrorBox(title, message);
  }

  openExternal(url: string): Promise<void> {
    return shell.openExternal(url);
  }

  openPath(absolutePath: string): Promise<string> {
    return shell.openPath(absolutePath);
  }

  notify(title: string, body: string): void {
    const notification = new Notification({ title, body });
    // Bring the app window to front when the notification is clicked
    notification.on('click', () => this.focusApp());
    notification.show();
  }

  isFocused(): boolean {
    return BrowserWindow.getFocusedWindow() !== null;
  }

  notificationsSupported(): boolean {
    return Notification.isSupported();
  }

  focusApp(): void {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  setTheme(theme: 'system' | 'light' | 'dark'): void {
    nativeTheme.themeSource = theme;
  }

  relaunch(): void {
    app.relaunch();
    app.exit(0);
  }

  exit(code: number): void {
    app.exit(code);
  }

  windowControl(action: WindowControl, ctx: CallContext): void {
    const win = windowOf(ctx);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'close') win.close();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }

  isWindowMaximized(ctx: CallContext): boolean {
    return windowOf(ctx)?.isMaximized() ?? false;
  }
}
