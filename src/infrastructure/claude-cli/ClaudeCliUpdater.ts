import { execFile } from 'child_process';
import { promisify } from 'util';
import type { IClaudeCliUpdater } from '@domain/interfaces';
import type { ClaudeCliUpdateResult } from '@domain/types';
import { CLAUDE_CLI_MANUAL_UPDATE_COMMAND, parseClaudeCliVersion } from '@domain/constants';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 10_000;
// `claude update` downloads a new binary — allow for a slow connection.
const UPDATE_TIMEOUT_MS = 180_000;

type ExecError = Error & { stdout?: string; stderr?: string };

function joinOutput(stdout: string | undefined, stderr: string | undefined): string {
  return [stdout, stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
}

/**
 * Reads the installed Claude CLI version and runs `claude update`.
 *
 * `isBusy` reports whether any Claude CLI process is running. The update is
 * refused while one is: on Windows a running `claude.exe` blocks replacing the
 * binary, and elsewhere it would swap the CLI out from under an active call.
 */
export class ClaudeCliUpdater implements IClaudeCliUpdater {
  constructor(private isBusy: () => boolean) {}

  async getVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: VERSION_TIMEOUT_MS });
      return parseClaudeCliVersion(stdout);
    } catch {
      return null;
    }
  }

  async update(): Promise<ClaudeCliUpdateResult> {
    const manualCommand = CLAUDE_CLI_MANUAL_UPDATE_COMMAND;
    const versionBefore = await this.getVersion();

    if (this.isBusy()) {
      return { status: 'busy', output: '', versionBefore, versionAfter: versionBefore, manualCommand };
    }
    if (versionBefore === null) {
      return { status: 'not-installed', output: '', versionBefore, versionAfter: null, manualCommand };
    }

    let output: string;
    let failed = false;
    try {
      const { stdout, stderr } = await execFileAsync('claude', ['update'], { timeout: UPDATE_TIMEOUT_MS });
      output = joinOutput(stdout, stderr);
    } catch (err) {
      const e = err as ExecError;
      output = joinOutput(e.stdout, e.stderr) || e.message;
      failed = true;
    }

    const versionAfter = await this.getVersion();
    const status = failed
      ? 'failed'
      : versionAfter !== null && versionAfter !== versionBefore
        ? 'updated'
        : 'up-to-date';
    return { status, output, versionBefore, versionAfter, manualCommand };
  }
}
