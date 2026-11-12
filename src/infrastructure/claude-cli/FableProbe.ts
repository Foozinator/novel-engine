import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import type { IFableProbe } from '@domain/interfaces';
import type { FableProbeStatus } from '@domain/types';
import { FABLE_MODEL_ID } from '@domain/constants';

const execFileAsync = promisify(execFile);

/**
 * A request that times out has still been billed, so the timeout is generous:
 * cutting it short only throws the answer away.
 */
const PROBE_TIMEOUT_MS = 60_000;

const PROBE_PROMPT = 'Reply with OK.';

/**
 * Flags that keep the probe as cheap as the CLI allows on subscription auth
 * (`--bare` needs ANTHROPIC_API_KEY, so it is not an option): replace the large
 * default system prompt, and load no tools, MCP servers, hooks or settings.
 */
export const FABLE_PROBE_ARGS: readonly string[] = [
  '-p', PROBE_PROMPT,
  '--model', FABLE_MODEL_ID,
  '--output-format', 'json',
  '--system-prompt', PROBE_PROMPT,
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--no-session-persistence',
];

/** The CLI's messages for a model alias this account cannot use. */
const UNAVAILABLE_MARKERS = [
  'issue with the selected model',
  'may not exist or you may not have access',
];

type ExecError = Error & { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };

export type FableProbeOutcome = { status: FableProbeStatus; detail?: string };

/** Classifies CLI output. `failed` is true when the process exited non-zero or was killed. */
export function classifyFableProbeOutput(stdout: string, stderr: string, failed: boolean): FableProbeOutcome {
  const combined = `${stdout}\n${stderr}`;
  if (UNAVAILABLE_MARKERS.some((m) => combined.includes(m))) {
    return { status: 'unavailable' };
  }

  let parsed: { is_error?: unknown; result?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout.trim()) as { is_error?: unknown; result?: unknown };
  } catch {
    parsed = null;
  }

  if (!failed && parsed && parsed.is_error !== true) {
    return { status: 'available' };
  }

  const reason = parsed && typeof parsed.result === 'string' && parsed.result
    ? parsed.result
    : (stderr.trim() || stdout.trim() || 'no output');
  return { status: 'error', detail: reason.slice(0, 200) };
}

/**
 * Checks whether the Claude CLI accepts the `fable` alias for this account.
 * Uses the alias rather than a dated ID so it keeps working as the CLI moves
 * the alias to newer Fable releases.
 *
 * A successful probe is a billed Fable request. Only run it on demand.
 */
export class FableProbe implements IFableProbe {
  async probe(): Promise<FableProbeOutcome> {
    try {
      const { stdout, stderr } = await execFileAsync('claude', [...FABLE_PROBE_ARGS], {
        timeout: PROBE_TIMEOUT_MS,
        // Run outside any project so no project CLAUDE.md is picked up.
        cwd: os.tmpdir(),
      });
      return classifyFableProbeOutput(stdout, stderr, false);
    } catch (err) {
      const e = err as ExecError;
      if (e.killed) return { status: 'error', detail: 'timed out' };
      if (e.code === 'ENOENT') return { status: 'error', detail: 'claude CLI not found' };
      return classifyFableProbeOutput(e.stdout ?? '', e.stderr ?? e.message, true);
    }
  }
}
