import type { CallContext } from '../host';

/**
 * Transport-neutral channel router (#72). Handlers register here; a transport
 * (Electron `ipcMain`, later a web socket) binds the table and calls `dispatch`.
 */

export type RouteKind = 'invoke' | 'send';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (ctx: CallContext, ...args: any[]) => unknown;

export interface RouteEntry {
  channel: string;
  kind: RouteKind;
}

export interface IpcRouter {
  /** Request/response channel. The handler's result (or error) goes back to the caller. */
  handle(channel: string, handler: RouteHandler): void;
  /** Fire-and-forget channel. */
  on(channel: string, handler: RouteHandler): void;
}

export class ChannelRouter implements IpcRouter {
  private readonly routes = new Map<string, { kind: RouteKind; handler: RouteHandler }>();

  handle(channel: string, handler: RouteHandler): void {
    this.add(channel, 'invoke', handler);
  }

  on(channel: string, handler: RouteHandler): void {
    this.add(channel, 'send', handler);
  }

  private add(channel: string, kind: RouteKind, handler: RouteHandler): void {
    if (this.routes.has(channel)) throw new Error(`Channel registered twice: ${channel}`);
    this.routes.set(channel, { kind, handler });
  }

  /** The channel table. Preload and any other bridge are checked against this. */
  table(): RouteEntry[] {
    return [...this.routes].map(([channel, { kind }]) => ({ channel, kind }));
  }

  has(channel: string): boolean {
    return this.routes.has(channel);
  }

  /** Run a channel's handler. Throws for an unknown channel. */
  dispatch(channel: string, ctx: CallContext, args: unknown[]): unknown {
    const route = this.routes.get(channel);
    if (!route) throw new Error(`No handler for channel ${channel}`);
    return route.handler(ctx, ...args);
  }
}
