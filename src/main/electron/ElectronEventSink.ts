import { BrowserWindow } from 'electron';
import type { PushChannel } from '@domain/channels';
import type { EventSink } from '../host';

/**
 * Sends push events to every open window.
 *
 * Windows can exist (not destroyed) while their render frame is disposed (e.g.
 * during a renderer refresh or OOM crash). Skipping those avoids hundreds of
 * "Render frame was disposed" log lines when the main process keeps streaming
 * to a dead renderer. Broadcasting to all windows (not just the caller) also
 * means a reloaded page's fresh listener receives live events.
 */
export class ElectronEventSink implements EventSink {
  broadcast(channel: PushChannel, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      try {
        w.webContents.send(channel, ...args);
      } catch {
        // Window may be closing — skip silently
      }
    }
  }
}
