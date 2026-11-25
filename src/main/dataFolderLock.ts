import { app, dialog } from 'electron';
import { APP_NAME } from '@domain/constants';
import { acquireDataFolderLock, describeHolder } from '@infra/lock';
import { chooseDataFolder, relaunch } from './dataFolderDialogs';

/**
 * Take the data-folder lock (#75). If another instance holds it, offer to quit
 * or pick another folder. Returns the release function, or `null` when the app
 * is relaunching or quitting and initialisation must stop.
 */
export async function acquireFolderLockOrAsk(defaultDir: string, dir: string): Promise<(() => void) | null> {
  for (;;) {
    let result;
    try {
      result = acquireDataFolderLock(dir, APP_NAME);
    } catch (err) {
      // Locking itself failed (e.g. a share without lock support). Don't block startup.
      console.warn('[data-folder] Could not take the folder lock:', (err as Error).message);
      return () => {};
    }
    if (result.acquired) return result.release;

    const buttons = ['Use another folder…', 'Quit'];
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'This data folder is already in use.',
      detail:
        `${dir}\n\nIt is open in ${describeHolder(result.holder)}. ` +
        'Two instances writing to one folder would corrupt it. Close the other one, or use a different folder.',
      buttons,
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.exit(0);
      return null;
    }
    if (await chooseDataFolder(null, defaultDir, dir)) {
      relaunch();
      return null;
    }
  }
}
