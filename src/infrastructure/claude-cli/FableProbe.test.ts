import { beforeEach, describe, expect, it, vi } from 'vitest';

// FableProbe promisifies execFile at module load — the mock must supply the
// promisify.custom implementation before the module is imported.
const execFileMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>>(),
);

vi.mock('child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = Object.assign(() => undefined, { [promisify.custom]: execFileMock });
  return { execFile };
});

import { FableProbe, FABLE_PROBE_ARGS, classifyFableProbeOutput } from './FableProbe';

function execError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed'), fields);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('classifyFableProbeOutput', () => {
  it('reports unavailable on the CLI model-access message', () => {
    expect(classifyFableProbeOutput('', 'There was an issue with the selected model', true).status).toBe('unavailable');
    expect(classifyFableProbeOutput('It may not exist or you may not have access to it', '', false).status).toBe('unavailable');
  });

  it('reports available for successful JSON', () => {
    expect(classifyFableProbeOutput('{"is_error":false,"result":"OK"}', '', false)).toEqual({ status: 'available' });
  });

  it('reports error for is_error JSON, non-JSON output, or a failed exit', () => {
    expect(classifyFableProbeOutput('{"is_error":true,"result":"rate limited"}', '', false))
      .toEqual({ status: 'error', detail: 'rate limited' });
    expect(classifyFableProbeOutput('garbage', '', false).status).toBe('error');
    expect(classifyFableProbeOutput('{"is_error":false}', 'boom', true).status).toBe('error');
  });
});

describe('FableProbe', () => {
  it('runs the cheap flag set against the fable alias', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"is_error":false,"result":"OK"}', stderr: '' });
    expect(await new FableProbe().probe()).toEqual({ status: 'available' });

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual([...FABLE_PROBE_ARGS]);
    expect(args).toEqual(expect.arrayContaining(['--model', 'fable', '--system-prompt', '--strict-mcp-config']));
    expect(opts).toMatchObject({ timeout: 60_000 });
  });

  it('maps a timeout and a missing CLI to error', async () => {
    execFileMock.mockRejectedValueOnce(execError({ killed: true }));
    expect(await new FableProbe().probe()).toEqual({ status: 'error', detail: 'timed out' });

    execFileMock.mockRejectedValueOnce(execError({ code: 'ENOENT' }));
    expect(await new FableProbe().probe()).toEqual({ status: 'error', detail: 'claude CLI not found' });
  });

  it('maps a non-zero exit with the access message to unavailable', async () => {
    execFileMock.mockRejectedValueOnce(execError({ code: 1, stdout: '', stderr: 'There was an issue with the selected model (fable).' }));
    expect((await new FableProbe().probe()).status).toBe('unavailable');
  });
});
