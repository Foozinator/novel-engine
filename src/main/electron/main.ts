import { app, BrowserWindow, nativeTheme, protocol, net, shell } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/**
 * On macOS (and Linux), GUI apps launched from the Dock or Finder don't
 * inherit the user's shell PATH. This means binaries installed via npm,
 * nvm, homebrew, etc. are invisible to child_process.spawn/execFile.
 *
 * Fix: run the user's login shell with `-l` to source ~/.bash_profile /
 * ~/.zprofile / etc., grab the resulting PATH, and inject it into
 * process.env before any services try to locate `claude`.
 */
async function fixShellPath(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    const shell = process.env.SHELL ?? '/bin/bash';
    const { stdout } = await execFileAsync(shell, ['-l', '-c', 'echo $PATH'], {
      timeout: 5_000,
    });
    const shellPath = stdout.trim();
    if (shellPath) {
      process.env.PATH = shellPath;
    }
  } catch {
    // Cannot resolve login shell PATH — keep existing process.env.PATH.
    // The app will still work if `claude` is discoverable via the current PATH.
  }
}

// Prevent uncaught errors from crashing the app — log and continue.
// The most common cause is EPIPE when a spawned CLI process dies mid-stream.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
import squirrelStartup from 'electron-squirrel-startup';
if (squirrelStartup) {
  app.quit();
}

// Data folder (#39): every app path derives from `userData`, so redirecting it
// here — before `whenReady` — moves the DB, books, agents and settings at once.
// Chromium's sessionData follows, so renderer localStorage is per folder too.
import { LEGACY_DATA_FOLDER_NAME, resolveDataDir } from '../dataLocation';
import { runStartupDataFolderChecks } from '../dataFolderDialogs';
import { acquireFolderLockOrAsk } from '../dataFolderLock';
import { createAppUrlMatcher } from '../appUrl';
// Default is `{appData}/Novel Engine Spur` (from package.json productName).
// The pre-rename `{appData}/Novel Engine` is offered for import on first launch.
const defaultDataDir = app.getPath('userData');
const legacyDataDir = path.join(app.getPath('appData'), LEGACY_DATA_FOLDER_NAME);
const dataResolution = resolveDataDir({ defaultDir: defaultDataDir, argv: process.argv, env: process.env });
if (dataResolution.problem) {
  console.warn('[data-folder]', dataResolution.problem);
} else if (dataResolution.dir !== defaultDataDir) {
  app.setPath('userData', dataResolution.dir);
}


import { MigrationBackupError } from '@infra/database';
import { resolveBookPath } from '@infra/filesystem';
import { APP_NAME } from '@domain/constants';
import { composeApp, type Composition } from '../composition';
import { registerIpcHandlers } from '../ipc/handlers';
import { ChannelRouter } from '../ipc/router';
import { ElectronHost } from './ElectronHost';
import { ElectronEventSink } from './ElectronEventSink';
import { bindRouterToIpcMain } from './ipcBinding';

// Vite globals injected by Electron Forge
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const host = new ElectronHost();
const events = new ElectronEventSink();

// Module-level references for lifecycle cleanup
let composition: Composition | null = null;
let releaseDataFolderLock: (() => void) | null = null;
let mainWindow: BrowserWindow | null = null;

/** The renderer's entry page, packaged builds. */
const INDEX_HTML_PATH = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

/** True only for the app's own page: the window lock and the IPC sender check use it. */
const isAppUrl = createAppUrlMatcher({
  devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
  indexHtmlPath: INDEX_HTML_PATH,
});

// ── Custom Protocol ────────────────────────────────────────────────
// Register before app.whenReady() per Electron docs
protocol.registerSchemesAsPrivileged([
  { scheme: 'novel-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ── Window ─────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the window on the app's own page. Links that would navigate away
  // open in the system browser instead (https only); new windows are denied.
  const openExternally = (url: string): void => {
    if (/^https:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {
        // Browser launch failed — nothing to do.
      });
    }
  };
  const keepOnAppPage = (event: Electron.Event, url: string): void => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  };
  mainWindow.webContents.on('will-navigate', keepOnAppPage);
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  // Forward maximize/unmaximize events to renderer for title bar button state
  mainWindow.on('maximize', () => events.broadcast('window:maximized'));
  mainWindow.on('unmaximize', () => events.broadcast('window:unmaximized'));

  // Vite dev server or production file
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(INDEX_HTML_PATH);
  }
}

// ── Startup ────────────────────────────────────────────────────────

async function initializeApp(): Promise<void> {
  // Expand PATH before anything else so child processes can find `claude`
  // and other user-installed binaries (nvm node, homebrew tools, etc.)
  await fixShellPath();

  // 0. Data folder checks (unusable folder, or first launch on shared data).
  if (await runStartupDataFolderChecks(host, defaultDataDir, legacyDataDir, dataResolution)) return;

  const userDataPath = app.getPath('userData');

  // 0b. Refuse a data folder another instance has open (#75).
  releaseDataFolderLock = await acquireFolderLockOrAsk(host, defaultDataDir, userDataPath);
  if (!releaseDataFolderLock) return;

  // In dev mode with Electron Forge + Vite, `__dirname` resolves to the Vite
  // output directory (`.vite/build/`), not the project root. `app.getAppPath()`
  // is more reliable as Forge sets this to the project root during `electron-forge start`.
  //
  // In production, `process.resourcesPath` already points to the `resources/` folder
  // inside the app bundle. In development, the binary lives in `{projectRoot}/resources/`,
  // so we append that segment manually to match what `resolvePandocPath` expects.
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');

  // Agent source directory resolution:
  //   - Production: `extraResource: ['./agents']` bundles the agents directory
  //     directly into `process.resourcesPath/agents/`.
  //   - Dev: the agents directory lives at the project root (`{appPath}/agents/`),
  //     NOT inside `resources/`.
  const agentsSourceDir = app.isPackaged
    ? path.join(process.resourcesPath, 'agents')
    : path.join(app.getAppPath(), 'agents');

  const guideSourcePath = app.isPackaged
    ? path.join(process.resourcesPath, 'docs', 'USER_GUIDE.md')
    : path.join(app.getAppPath(), 'docs', 'USER_GUIDE.md');

  // 1. Build every service.
  try {
    composition = await composeApp({ userDataPath, resourcesPath, agentsSourceDir, guideSourcePath, host, events });
  } catch (err) {
    // The pre-migration snapshot failed: the DB is left as it was and the app quits.
    if (!(err instanceof MigrationBackupError)) throw err;
    console.error('[startup]', err);
    host.showError(`${APP_NAME} cannot start`, err.message);
    host.exit(1);
    return;
  }
  const { booksDir } = composition;

  // 2. Register custom protocol handler for serving local assets to renderer
  protocol.handle('novel-asset', (request) => {
    const url = new URL(request.url);

    if (url.hostname === 'cover') {
      try {
        const bookSlug = decodeURIComponent(url.pathname.replace(/^\//, ''));
        const aboutPath = resolveBookPath(booksDir, bookSlug, 'about.json');
        const aboutRaw = readFileSync(aboutPath, 'utf-8');
        const about = JSON.parse(aboutRaw) as { coverImage?: string };

        if (about.coverImage) {
          // Throws if coverImage points outside the book.
          const coverAbsPath = resolveBookPath(booksDir, bookSlug, about.coverImage);
          return net.fetch(pathToFileURL(coverAbsPath).href);
        }
      } catch {
        // Bad slug, missing or malformed about.json, or a cover outside the book — 404
      }

      return new Response('Not found', { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  });

  // 3. Register IPC handlers (with hook to switch watcher on book change)
  const router = new ChannelRouter();
  registerIpcHandlers(
    router,
    host,
    events,
    composition.services,
    {
      userDataPath,
      booksDir,
      dataFolder: {
        current: userDataPath,
        defaultDir: defaultDataDir,
        // A rejected override runs on the default folder this session.
        source: dataResolution.problem ? 'default' : dataResolution.source,
      },
      promptSync: composition.promptSync,
    },
    { onActiveBookChanged: composition.onActiveBookChanged },
  );
  bindRouterToIpcMain(router, isAppUrl);

  // 4. Create the window
  createWindow();
}

// ── App Lifecycle ──────────────────────────────────────────────────

app.whenReady().then(initializeApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Clean up database connection and file watchers on quit
app.on('before-quit', () => {
  composition?.dispose();
  releaseDataFolderLock?.();
});
