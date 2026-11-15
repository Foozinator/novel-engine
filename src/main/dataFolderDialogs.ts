import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { DataFolderKind } from '@domain/types';
import {
  DATA_DIR_ENV,
  checkUsable,
  classifyFolder,
  needsFirstLaunchChoice,
  writePointer,
  type ResolvedDataDir,
} from './dataLocation';

/**
 * Native dialogs for choosing the data folder (#39). Shared by the startup
 * checks in `index.ts` and the Settings → Data Folder IPC handlers.
 */

const KIND_DETAIL: Record<DataFolderKind, string> = {
  empty: 'This folder is empty. Novel Engine will start fresh there.',
  'novel-engine': 'This folder already holds Novel Engine data. Novel Engine will use the books and history in it.',
  other:
    'This folder already contains other files. Novel Engine will add its own files next to them. A new, empty folder is safer.',
};

async function showBox(win: BrowserWindow | null, options: Electron.MessageBoxOptions) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/** Restart the app so the new data folder takes effect. */
export function relaunch(): void {
  app.relaunch();
  app.exit(0);
}

/**
 * Ask for a folder, confirm based on what it contains, and write the pointer.
 * Returns the chosen path, or `null` if the user cancelled.
 */
export async function chooseDataFolder(
  win: BrowserWindow | null,
  defaultDir: string,
  currentDir: string,
): Promise<string | null> {
  for (;;) {
    const pick = win
      ? await dialog.showOpenDialog(win, pickOptions(currentDir))
      : await dialog.showOpenDialog(pickOptions(currentDir));
    if (pick.canceled || pick.filePaths.length === 0) return null;

    const chosen = path.normalize(pick.filePaths[0]);
    if (chosen === path.normalize(currentDir)) return null; // nothing to change

    const problem = checkUsable(chosen);
    if (problem) {
      await showBox(win, { type: 'error', message: 'That folder cannot be used.', detail: problem });
      continue;
    }

    const kind = classifyFolder(chosen);
    const { response } = await showBox(win, {
      type: kind === 'other' ? 'warning' : 'question',
      message: `Use ${chosen} as the data folder?`,
      detail: `${KIND_DETAIL[kind]}\n\nNovel Engine will restart. Your current folder is left as it is.`,
      buttons: ['Use this folder and restart', 'Choose a different folder…', 'Cancel'],
      defaultId: kind === 'other' ? 1 : 0,
      cancelId: 2,
    });
    if (response === 2) return null;
    if (response === 1) continue;

    writePointer(defaultDir, chosen === path.normalize(defaultDir) ? null : chosen);
    return chosen;
  }
}

function pickOptions(currentDir: string): Electron.OpenDialogOptions {
  return {
    title: 'Choose Novel Engine data folder',
    defaultPath: path.dirname(currentDir),
    properties: ['openDirectory', 'createDirectory'],
  };
}

/** Point back at the default folder after confirming. Returns false if cancelled. */
export async function resetDataFolder(win: BrowserWindow | null, defaultDir: string): Promise<boolean> {
  const kind = classifyFolder(defaultDir);
  const { response } = await showBox(win, {
    type: 'question',
    message: `Go back to the default data folder?`,
    detail: `${defaultDir}\n\n${KIND_DETAIL[kind]}\n\nNovel Engine will restart. Your current folder is left as it is.`,
    buttons: ['Use default and restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  writePointer(defaultDir, null);
  return true;
}

/**
 * Startup checks, run before bootstrap. Returns `true` when the app is
 * relaunching or quitting and initialisation must stop.
 *
 * - The requested folder is unusable → choose another, use the default for
 *   this session, or quit.
 * - First launch with existing data in the shared default folder (e.g. an
 *   upstream install) → use it, or choose a separate folder. Asked once.
 */
export async function runStartupDataFolderChecks(defaultDir: string, resolved: ResolvedDataDir): Promise<boolean> {
  if (resolved.problem) {
    const overridden = resolved.source === 'flag' || resolved.source === 'env';
    const how =
      resolved.source === 'flag' ? 'the --data-dir option' : resolved.source === 'env' ? DATA_DIR_ENV : 'Settings';
    const buttons = overridden
      ? ['Use default folder this session', 'Quit']
      : ['Choose another folder…', 'Use default folder this session', 'Quit'];
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: 'The Novel Engine data folder is unavailable.',
        detail: `${resolved.problem}\n\nThis folder was set by ${how}.\nDefault folder: ${defaultDir}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[response];
      if (choice === 'Quit') {
        app.exit(0);
        return true;
      }
      if (choice === 'Use default folder this session') return false;
      if (await chooseDataFolder(null, defaultDir, defaultDir)) {
        relaunch();
        return true;
      }
    }
  }

  if (needsFirstLaunchChoice(defaultDir, resolved)) {
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Novel Engine data already exists in the default folder.',
        detail:
          `${defaultDir}\n\n` +
          'Another Novel Engine install may be using it. If you use it here, both installs share the same books, ' +
          'database and agent prompts. Choose a separate folder to keep them apart.\n\n' +
          'You can change this later in Settings → Data Folder.',
        buttons: ['Use this folder', 'Choose a separate folder…'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 0) {
        writePointer(defaultDir, null);
        return false;
      }
      if (await chooseDataFolder(null, defaultDir, defaultDir)) {
        relaunch();
        return true;
      }
    }
  }

  return false;
}
