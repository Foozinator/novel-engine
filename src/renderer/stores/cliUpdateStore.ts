import { create } from 'zustand';
import type { ClaudeCliUpdateResult, StreamEvent } from '@domain/types';
import { parseClaudeCliVersionError } from '@domain/constants';

type TaggedStreamEvent = StreamEvent & { callId?: string; conversationId?: string; source?: string };

/**
 * Why the Claude CLI update banner is showing.
 * - `version-required` — a call failed because the installed CLI is too old
 *   for the model an alias resolved to. `conversationId` is set when the
 *   failed call was a chat message, so the banner can offer a retry.
 * - `reminder` — the weekly launch-time offer to check for updates.
 * - `manual` — the user clicked "Check for updates now" in Settings.
 */
export type CliUpdatePrompt =
  | {
      kind: 'version-required';
      currentVersion: string | null;
      requiredVersion: string;
      message: string;
      conversationId: string | null;
    }
  | { kind: 'reminder'; version: string }
  | { kind: 'manual' };

type CliUpdateState = {
  prompt: CliUpdatePrompt | null;
  running: boolean;
  result: ClaudeCliUpdateResult | null;
  _cleanupListener: (() => void) | null;

  /** Listen to every stream event (all sources) for the "version X or newer is required" error. */
  initListener: () => void;
  destroyListener: () => void;
  /** Show the banner if `message` is the CLI's version-required error. Returns whether it matched. */
  reportError: (message: string, conversationId?: string | null) => boolean;
  /** Ask main whether the weekly reminder is due; show it if so. */
  checkReminder: () => Promise<void>;
  runUpdate: () => Promise<void>;
  /** Show the banner and run the update straight away (Settings button). */
  checkNow: () => Promise<void>;
  dismiss: () => void;
};

export const useCliUpdateStore = create<CliUpdateState>((set, get) => ({
  prompt: null,
  running: false,
  result: null,
  _cleanupListener: null,

  initListener: () => {
    get()._cleanupListener?.();
    const cleanup = window.novelEngine.chat.onStreamEvent((event) => {
      const tagged = event as TaggedStreamEvent;
      if (tagged.type !== 'error') return;
      get().reportError(tagged.message, tagged.source === 'chat' ? tagged.conversationId ?? null : null);
    });
    set({ _cleanupListener: cleanup });
  },

  destroyListener: () => {
    get()._cleanupListener?.();
    set({ _cleanupListener: null });
  },

  reportError: (message, conversationId = null) => {
    const parsed = parseClaudeCliVersionError(message);
    if (!parsed) return false;
    // Don't replace a banner that is mid-update or already showing its result.
    if (get().running) return true;
    set({
      prompt: { kind: 'version-required', ...parsed, message, conversationId },
      result: null,
    });
    return true;
  },

  checkReminder: async () => {
    try {
      const reminder = await window.novelEngine.claudeCli.checkUpdateReminder();
      if (reminder.due && reminder.version && !get().prompt) {
        set({ prompt: { kind: 'reminder', version: reminder.version }, result: null });
      }
    } catch (err) {
      console.warn('[cliUpdate] reminder check failed:', err);
    }
  },

  runUpdate: async () => {
    if (get().running) return;
    set({ running: true, result: null });
    try {
      const result = await window.novelEngine.claudeCli.runUpdate();
      set({ result });
    } catch (err) {
      set({
        result: {
          status: 'failed',
          output: err instanceof Error ? err.message : String(err),
          versionBefore: null,
          versionAfter: null,
          manualCommand: 'claude update',
        },
      });
    } finally {
      set({ running: false });
    }
  },

  checkNow: async () => {
    if (get().running) return;
    set({ prompt: { kind: 'manual' }, result: null });
    await get().runUpdate();
  },

  dismiss: () => set({ prompt: null, result: null }),
}));
