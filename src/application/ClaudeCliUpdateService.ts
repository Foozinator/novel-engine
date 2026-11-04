import type { IClaudeCliUpdateService, IClaudeCliUpdater, ISettingsService } from '@domain/interfaces';
import type { ClaudeCliUpdateReminder, ClaudeCliUpdateResult } from '@domain/types';
import { CLAUDE_CLI_UPDATE_CHECK_INTERVAL_MS } from '@domain/constants';

/**
 * Decides when to offer a Claude CLI update and runs it.
 *
 * Model aliases can move to a model the installed CLI is too old to run, and
 * every NE call is a short `-p` process, so the CLI's own background
 * auto-update may never get a chance to run.
 */
export class ClaudeCliUpdateService implements IClaudeCliUpdateService {
  constructor(
    private settings: ISettingsService,
    private updater: IClaudeCliUpdater,
    private now: () => Date = () => new Date(),
  ) {}

  async checkReminder(): Promise<ClaudeCliUpdateReminder> {
    const appSettings = await this.settings.load();
    if (!appSettings.claudeCliUpdateReminder || !appSettings.hasClaudeCli) {
      return { due: false, version: null };
    }

    const last = appSettings.lastClaudeCliUpdateCheck
      ? Date.parse(appSettings.lastClaudeCliUpdateCheck)
      : Number.NaN;
    const now = this.now();
    if (!Number.isNaN(last) && now.getTime() - last < CLAUDE_CLI_UPDATE_CHECK_INTERVAL_MS) {
      return { due: false, version: null };
    }

    const version = await this.updater.getVersion();
    if (version === null) return { due: false, version: null };

    await this.settings.update({ lastClaudeCliUpdateCheck: now.toISOString() });
    return { due: true, version };
  }

  async runUpdate(): Promise<ClaudeCliUpdateResult> {
    const result = await this.updater.update();
    if (result.status !== 'busy') {
      await this.settings.update({ lastClaudeCliUpdateCheck: this.now().toISOString() });
    }
    return result;
  }
}
