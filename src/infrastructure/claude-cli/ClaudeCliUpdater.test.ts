import { beforeEach, describe, expect, it, vi } from 'vitest';

// ClaudeCliUpdater promisifies execFile at module load — the mock must supply
// the promisify.custom implementation before the module is imported.
const execFileMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>>(),
);

vi.mock('child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = Object.assign(() => undefined, { [promisify.custom]: execFileMock });
  return { execFile };
});

import { ClaudeCliUpdater } from './ClaudeCliUpdater';

/** Script `claude --version` answers in order; `claude update` uses `onUpdate`. */
function script(versions: (string | null)[], onUpdate?: () => Promise<{ stdout: string; stderr: string }>): void {
  const queue = [...versions];
  execFileMock.mockImplementation(async (_cmd, args) => {
    if (args[0] === '--version') {
      const v = queue.shift();
      if (v === null || v === undefined) throw new Error('ENOENT');
      return { stdout: `${v} (Claude Code)\n`, stderr: '' };
    }
    if (args[0] === 'update') {
      if (!onUpdate) throw new Error('update not scripted');
      return onUpdate();
    }
    throw new Error(`unexpected args ${args.join(' ')}`);
  });
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('ClaudeCliUpdater', () => {
  it('getVersion parses the version, or returns null when the CLI is missing', async () => {
    script(['2.1.318', null]);
    const updater = new ClaudeCliUpdater(() => false);
    expect(await updater.getVersion()).toBe('2.1.318');
    expect(await updater.getVersion()).toBeNull();
  });

  it('reports updated when the version changes, with the command output', async () => {
    script(['2.1.220', '2.1.318'], async () => ({ stdout: 'Updating…\nUpdated to 2.1.318\n', stderr: '' }));
    const result = await new ClaudeCliUpdater(() => false).update();
    expect(result).toEqual({
      status: 'updated',
      output: 'Updating…\nUpdated to 2.1.318',
      versionBefore: '2.1.220',
      versionAfter: '2.1.318',
      manualCommand: 'claude update',
    });
  });

  it('reports up-to-date when the version is unchanged', async () => {
    script(['2.1.318', '2.1.318'], async () => ({ stdout: 'Claude Code is up to date', stderr: '' }));
    const result = await new ClaudeCliUpdater(() => false).update();
    expect(result.status).toBe('up-to-date');
  });

  it('reports failed with stdout/stderr when `claude update` exits non-zero', async () => {
    script(['2.1.220', '2.1.220'], async () => {
      throw Object.assign(new Error('Command failed'), {
        stdout: '',
        stderr: 'Cannot update: installed via a package manager',
      });
    });
    const result = await new ClaudeCliUpdater(() => false).update();
    expect(result.status).toBe('failed');
    expect(result.output).toBe('Cannot update: installed via a package manager');
  });

  it('refuses to run while a Claude CLI process is active', async () => {
    script(['2.1.220']);
    const result = await new ClaudeCliUpdater(() => true).update();
    expect(result.status).toBe('busy');
    expect(execFileMock.mock.calls.some(([, args]) => args[0] === 'update')).toBe(false);
  });

  it('reports not-installed without running update when there is no CLI', async () => {
    script([null]);
    const result = await new ClaudeCliUpdater(() => false).update();
    expect(result.status).toBe('not-installed');
    expect(execFileMock.mock.calls.some(([, args]) => args[0] === 'update')).toBe(false);
  });
});
