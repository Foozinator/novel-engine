import { ipcMain } from 'electron';
import type { PushChannel } from '@domain/channels';
import type { CallContext } from '../host';
import type { ChannelRouter } from '../ipc/router';

/**
 * Bind the router's channel table to Electron's `ipcMain`. Only the app's own
 * page may call: a request from any other frame (another URL, or a destroyed
 * frame) is refused before its handler runs.
 */
export function bindRouterToIpcMain(router: ChannelRouter, isAppUrl: (url: string) => boolean): void {
  const refusal = (channel: string, senderUrl: unknown): string | null =>
    typeof senderUrl === 'string' && isAppUrl(senderUrl)
      ? null
      : `Refused ${channel}: the call did not come from the app window`;

  const contextFor = (sender: Electron.WebContents): CallContext => ({
    sender,
    reply: (channel: PushChannel, ...args: unknown[]) => {
      if (!sender.isDestroyed()) sender.send(channel, ...args);
    },
  });

  for (const { channel, kind } of router.table()) {
    if (kind === 'invoke') {
      ipcMain.handle(channel, (event, ...args) => {
        const refused = refusal(channel, event.senderFrame?.url);
        if (refused) throw new Error(refused);
        return router.dispatch(channel, contextFor(event.sender), args);
      });
    } else {
      ipcMain.on(channel, (event, ...args) => {
        const refused = refusal(channel, event.senderFrame?.url);
        if (refused) {
          console.warn(`[ipc] ${refused}`);
          return;
        }
        router.dispatch(channel, contextFor(event.sender), args);
      });
    }
  }
}
