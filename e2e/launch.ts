import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Launch helper for the packaged Novel Engine app.
 *
 * Safety rules (the app is launched on a developer machine that may hold real books):
 * - Every run gets a fresh temporary data folder passed as `--user-data-dir`, so the
 *   real `Novel Engine` data folder is never read or written.
 * - PATH is reduced to a stub directory plus the OS system directories. The stub
 *   directory holds fake `claude`, `codex` and `ollama` commands that exit non-zero,
 *   so no model CLI can run and nothing is billed. On Linux/macOS, SHELL points at a
 *   stub too, because the app replaces PATH with the login shell's PATH at startup.
 */

const ROOT = path.resolve(__dirname, '..');
const STUB_COMMANDS = ['claude', 'codex', 'ollama'];

export type LaunchedApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  cleanup: () => Promise<void>;
};

/** Finds the binary that `electron-forge package` wrote for this platform. */
export function findPackagedExecutable(): string {
  const outDir = path.join(ROOT, 'out');
  const folder = `Novel Engine-${process.platform}-${process.arch}`;
  const candidates: Record<string, string> = {
    linux: path.join(outDir, folder, 'novel-engine'),
    win32: path.join(outDir, folder, 'novel-engine.exe'),
    darwin: path.join(outDir, folder, 'Novel Engine.app', 'Contents', 'MacOS', 'Novel Engine'),
  };
  const exe = candidates[process.platform];
  if (!exe || !existsSync(exe)) {
    const found = existsSync(outDir) ? readdirSync(outDir).join(', ') : '(no out/ folder)';
    throw new Error(
      `Packaged app not found at ${exe ?? `<unsupported platform ${process.platform}>`}.\n` +
        `Run \`npm run test:e2e\` (it packages first) or \`npm run package\`. out/ contains: ${found}`,
    );
  }
  return exe;
}

function writeStubs(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const name of STUB_COMMANDS) {
    if (process.platform === 'win32') {
      writeFileSync(path.join(binDir, `${name}.cmd`), '@echo off\r\nexit /b 127\r\n');
    } else {
      const file = path.join(binDir, name);
      writeFileSync(file, '#!/bin/sh\nexit 127\n');
      chmodSync(file, 0o755);
    }
  }
}

function safeEnv(binDir: string, stubDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Keep only what a GUI app needs to start; drop everything else (tokens, keys, ELECTRON_RUN_AS_NODE).
  const keep = [
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
    'SystemRoot', 'SystemDrive', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  ];
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.PATH = [binDir, path.join(sysRoot, 'System32'), sysRoot].join(';');
  } else {
    const sysPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    env.PATH = `${binDir}:${sysPath}`;
    const shell = path.join(stubDir, 'login-shell');
    // The app runs `$SHELL -l -c 'echo $PATH'` and adopts the result.
    writeFileSync(shell, `#!/bin/sh\necho "${binDir}:${sysPath}"\n`);
    chmodSync(shell, 0o755);
    env.SHELL = shell;
  }
  return env;
}

/** Seeds settings so the app skips onboarding, guided tours and the CLI update prompt. */
function seedSettings(userDataDir: string): void {
  writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(
      {
        initialized: true,
        authorName: 'E2E Smoke',
        completedTours: ['welcome', 'first-book', 'pipeline-intro'],
        claudeCliUpdateReminder: false,
        enableNotifications: false,
      },
      null,
      2,
    ),
  );
}

export async function launchApp(): Promise<LaunchedApp> {
  const executablePath = findPackagedExecutable();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'ne-e2e-'));
  const userDataDir = path.join(baseDir, 'user-data');
  const stubDir = path.join(baseDir, 'stubs');
  const binDir = path.join(stubDir, 'bin');
  mkdirSync(userDataDir, { recursive: true });
  writeStubs(binDir);
  seedSettings(userDataDir);

  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: safeEnv(binDir, stubDir),
    cwd: baseDir,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const cleanup = async () => {
    await app.close().catch(() => undefined);
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { app, page, userDataDir, cleanup };
}
