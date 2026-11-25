import type { PushChannel } from '@domain/channels';

/**
 * Host seams (#72). Everything the composition root and the IPC handlers need
 * from the platform they run on, so neither imports `electron`. The desktop app
 * implements these in `src/main/electron/`; a headless server supplies its own.
 */

/** Who is calling. The transport builds one per request. */
export interface CallContext {
  /** Opaque to everything but the host that created it (Electron: the sender's WebContents). */
  readonly sender: unknown;
  /** Send an event to the caller only (e.g. `build:progress`). */
  reply(channel: PushChannel, ...args: unknown[]): void;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickFilesOptions {
  title?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  /** Pick a folder instead of files. */
  directory?: boolean;
  /** Offer to create a folder (folder picker only). */
  createDirectory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
}

export interface SaveFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface ConfirmOptions {
  type?: 'info' | 'warning' | 'error' | 'question';
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export type WindowControl = 'minimize' | 'maximize' | 'close';

export interface HostAdapter {
  /** Open a file/folder picker. Returns the chosen paths, or `null` if cancelled. */
  pickFiles(options: PickFilesOptions, ctx?: CallContext | null): Promise<string[] | null>;
  /** Open a save dialog. Returns the chosen path, or `null` if cancelled. */
  saveFile(options: SaveFileOptions, ctx?: CallContext | null): Promise<string | null>;
  /** Show a message box. Returns the index of the pressed button. */
  confirm(options: ConfirmOptions, ctx?: CallContext | null): Promise<number>;
  /** Show a blocking error message (used when the app cannot start). */
  showError(title: string, message: string): void;
  openExternal(url: string): Promise<void>;
  /** Open a file or folder with the OS. Resolves to an error message, or '' on success. */
  openPath(absolutePath: string): Promise<string>;
  /** Fire an OS notification. */
  notify(title: string, body: string): void;
  /** True when the app has a focused window (notifications are then pointless). */
  isFocused(): boolean;
  /** True when the OS can show notifications. */
  notificationsSupported(): boolean;
  /** Bring the app window to the front (notification click). */
  focusApp(): void;
  setTheme(theme: 'system' | 'light' | 'dark'): void;
  /** Restart the app so a new data folder takes effect. */
  relaunch(): void;
  /** Quit with an exit code. */
  exit(code: number): void;
  /** Minimize, maximize/restore or close the caller's window. No-op without windows. */
  windowControl(action: WindowControl, ctx: CallContext): void;
  isWindowMaximized(ctx: CallContext): boolean;
}

/** Pushes events to every connected client. Dead or closing clients are skipped. */
export interface EventSink {
  broadcast(channel: PushChannel, ...args: unknown[]): void;
}
