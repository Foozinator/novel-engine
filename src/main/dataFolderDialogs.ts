import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { DataFolderKind } from '@domain/types';
import { APP_NAME } from '@domain/constants';
import {
  DATA_DIR_ENV,
  LEGACY_DATA_FOLDER_NAME,
  checkUsable,
  classifyFolder,
  copyAppData,
  needsLegacyImport,
  writePointer,
  type ResolvedDataDir,
} from './dataLocation';

/**
 * Native dialogs for choosing the data folder (#39). Shared by the startup
 * checks in `index.ts` and the Settings → Data Folder IPC handlers.
 */

const KIND_DETAIL: Record<DataFolderKind, string> = {
  empty: `This folder is empty. ${APP_NAME} will start fresh there.`,
  'novel-engine': `This folder already holds Novel Engine data. ${APP_NAME} will use the books and history in it.`,
  other: `This folder already contains other files. ${APP_NAME} will add its own files next to them. A new, empty folder is safer.`,
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
      detail: `${KIND_DETAIL[kind]}\n\n${APP_NAME} will restart. Your current folder is left as it is.`,
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
    title: `Choose ${APP_NAME} data folder`,
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
    detail: `${defaultDir}\n\n${KIND_DETAIL[kind]}\n\n${APP_NAME} will restart. Your current folder is left as it is.`,
    buttons: ['Use default and restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  writePointer(defaultDir, null);
  return true;
}

const COPY = 'Copy it here (recommended)';
const USE_IN_PLACE = 'Use the old folder in place';
const START_FRESH = 'Start fresh';
const RETRY = 'Try again';
const QUIT = 'Quit';

/**
 * First launch after the rename: offer to bring over the books and history
 * from the pre-rename `Novel Engine` folder. Returns `true` when relaunching
 * or quitting.
 */
async function offerLegacyImport(defaultDir: string, legacyDir: string): Promise<boolean> {
  for (;;) {
    const buttons = [COPY, USE_IN_PLACE, START_FRESH];
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Bring your books into ${APP_NAME}?`,
      detail:
        `Books and history from ${LEGACY_DATA_FOLDER_NAME} were found in:\n${legacyDir}\n\n` +
        `• Copy: ${APP_NAME} gets its own copy in ${defaultDir}. The old folder stays as it is, so ` +
        `an installed ${LEGACY_DATA_FOLDER_NAME} keeps working. Close ${LEGACY_DATA_FOLDER_NAME} before copying.\n` +
        `• Use in place: both apps share the old folder, its database and its agent prompts.\n` +
        `• Start fresh: begin with no books. You can switch later in Settings → Data Folder.`,
      buttons,
      defaultId: 0,
      cancelId: 2,
    });
    const choice = buttons[response];

    if (choice === START_FRESH) {
      writePointer(defaultDir, null);
      return false;
    }
    if (choice === USE_IN_PLACE) {
      writePointer(defaultDir, legacyDir);
      relaunch();
      return true;
    }

    try {
      const copied = await copyAppData(legacyDir, defaultDir);
      console.log('[data-folder] Copied from legacy folder:', copied.join(', '));
      writePointer(defaultDir, null);
      return false;
    } catch (err) {
      const errButtons = [RETRY, START_FRESH, QUIT];
      const { response: errResponse } = await dialog.showMessageBox({
        type: 'error',
        message: 'Copying your data failed. Nothing was changed.',
        detail: `${(err as Error).message}\n\nThe old folder is untouched.`,
        buttons: errButtons,
        defaultId: 0,
        cancelId: 2,
      });
      const errChoice = errButtons[errResponse];
      if (errChoice === QUIT) {
        app.exit(0);
        return true;
      }
      if (errChoice === START_FRESH) {
        writePointer(defaultDir, null);
        return false;
      }
      // RETRY → show the choice again
    }
  }
}

/**
 * Startup checks, run before bootstrap. Returns `true` when the app is
 * relaunching or quitting and initialisation must stop.
 *
 * - The requested folder is unusable → choose another, use the default for
 *   this session, or quit.
 * - First launch with data in the pre-rename `Novel Engine` folder → copy it,
 *   use it in place, or start fresh. Asked once.
 */
export async function runStartupDataFolderChecks(
  defaultDir: string,
  legacyDir: string,
  resolved: ResolvedDataDir,
): Promise<boolean> {
  if (resolved.problem) {
    const overridden = resolved.source === 'flag' || resolved.source === 'env';
    const how =
      resolved.source === 'flag' ? 'the --data-dir option' : resolved.source === 'env' ? DATA_DIR_ENV : 'Settings';
    const buttons = overridden
      ? ['Use default folder this session', QUIT]
      : ['Choose another folder…', 'Use default folder this session', QUIT];
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: `The ${APP_NAME} data folder is unavailable.`,
        detail: `${resolved.problem}\n\nThis folder was set by ${how}.\nDefault folder: ${defaultDir}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[response];
      if (choice === QUIT) {
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

  if (needsLegacyImport(defaultDir, legacyDir, resolved)) {
    return offerLegacyImport(defaultDir, legacyDir);
  }

  return false;
}
