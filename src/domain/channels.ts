/**
 * Push channels: events the main process sends to the renderer (not request/response).
 *
 * This is the single source of truth for them. `EventSink.broadcast` only accepts
 * these names, and a test checks that the preload bridge subscribes to exactly this
 * set. A future web bridge can be checked against the same list.
 *
 * Request channels (`namespace:action`) are the router's table; see
 * `ChannelRouter.table()` in `src/main/ipc/router.ts`.
 */
export const PUSH_CHANNELS = [
  'books:changed',
  'import:generationProgress',
  'chat:streamEvent',
  'chat:filesChanged',
  'build:progress',
  'revision:event',
  'motifLedger:normalizing',
  'window:maximized',
  'window:unmaximized',
  'query:onStream',
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];
