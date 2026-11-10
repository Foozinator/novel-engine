import { describe, expect, it, vi } from 'vitest';
import type { IClaudeCliUpdater, ISettingsService } from '@domain/interfaces';
import type { AppSettings, ClaudeCliUpdateResult } from '@domain/types';
import { DEFAULT_SETTINGS } from '@domain/constants';
import { ClaudeCliUpdateService } from './ClaudeCliUpdateService';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function makeSettings(overrides: Partial<AppSettings> = {}): ISettingsService & { current: AppSettings } {
  const store = {
    current: { ...DEFAULT_SETTINGS, hasClaudeCli: true, ...overrides },
    load: vi.fn(async () => store.current),
    update: vi.fn(async (partial: Partial<AppSettings>) => {
      store.current = { ...store.current, ...partial };
    }),
  };
  return store as unknown as ISettingsService & { current: AppSettings };
}

function makeUpdater(version: string | null, result?: Partial<ClaudeCliUpdateResult>): IClaudeCliUpdater {
  return {
    getVersion: vi.fn(async () => version),
    update: vi.fn(async () => ({
      status: 'up-to-date' as const,
      output: '',
      versionBefore: version,
      versionAfter: version,
      manualCommand: 'claude update',
      ...result,
    })),
  };
}

describe('ClaudeCliUpdateService.checkReminder', () => {
  it('is due on first launch and records when it was offered', async () => {
    const settings = makeSettings();
    const service = new ClaudeCliUpdateService(settings, makeUpdater('2.1.318'), () => NOW);

    expect(await service.checkReminder()).toEqual({ due: true, version: '2.1.318' });
    expect(settings.current.lastClaudeCliUpdateCheck).toBe(NOW.toISOString());
  });

  it('is not due within a week of the last offer, and due again after', async () => {
    const recent = makeSettings({ lastClaudeCliUpdateCheck: new Date(NOW.getTime() - 6 * DAY).toISOString() });
    expect((await new ClaudeCliUpdateService(recent, makeUpdater('2.1.318'), () => NOW).checkReminder()).due).toBe(false);

    const old = makeSettings({ lastClaudeCliUpdateCheck: new Date(NOW.getTime() - 8 * DAY).toISOString() });
    expect((await new ClaudeCliUpdateService(old, makeUpdater('2.1.318'), () => NOW).checkReminder()).due).toBe(true);
  });

  it('is never due when the reminder is off or the CLI is missing, and does not run the CLI', async () => {
    const updater = makeUpdater('2.1.318');
    const off = makeSettings({ claudeCliUpdateReminder: false });
    const noCli = makeSettings({ hasClaudeCli: false });

    expect((await new ClaudeCliUpdateService(off, updater, () => NOW).checkReminder()).due).toBe(false);
    expect((await new ClaudeCliUpdateService(noCli, updater, () => NOW).checkReminder()).due).toBe(false);
    expect(updater.getVersion).not.toHaveBeenCalled();
    expect(off.update).not.toHaveBeenCalled();
  });

  it('is not due (and records nothing) when `claude --version` does not answer', async () => {
    const settings = makeSettings();
    const result = await new ClaudeCliUpdateService(settings, makeUpdater(null), () => NOW).checkReminder();
    expect(result.due).toBe(false);
    expect(settings.update).not.toHaveBeenCalled();
  });
});

describe('ClaudeCliUpdateService.runUpdate', () => {
  it('returns the updater result and records the check time', async () => {
    const settings = makeSettings();
    const updater = makeUpdater('2.1.220', { status: 'updated', versionAfter: '2.1.318' });
    const result = await new ClaudeCliUpdateService(settings, updater, () => NOW).runUpdate();
    expect(result.status).toBe('updated');
    expect(settings.current.lastClaudeCliUpdateCheck).toBe(NOW.toISOString());
  });

  it('does not record a check when the update was refused as busy', async () => {
    const settings = makeSettings();
    await new ClaudeCliUpdateService(settings, makeUpdater('2.1.220', { status: 'busy' }), () => NOW).runUpdate();
    expect(settings.update).not.toHaveBeenCalled();
  });
});
