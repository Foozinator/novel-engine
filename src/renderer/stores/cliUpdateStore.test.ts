import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCliUpdateStore } from './cliUpdateStore';
import { installNovelEngineMock, type NovelEngineMock } from '../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../test/resetStores';

resetStoresBeforeEach(useCliUpdateStore);

const VERSION_ERROR =
  'Claude CLI run failed: API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required.';

let mock: NovelEngineMock;

beforeEach(() => {
  mock = installNovelEngineMock();
});

afterEach(() => {
  useCliUpdateStore.getState().destroyListener();
});

describe('cliUpdateStore', () => {
  it('shows a version-required prompt for a matching chat error, keeping its conversation for retry', () => {
    useCliUpdateStore.getState().initListener();
    mock.emit('chat:streamEvent', { type: 'error', message: VERSION_ERROR, source: 'chat', conversationId: 'conv-1' });

    expect(useCliUpdateStore.getState().prompt).toEqual({
      kind: 'version-required',
      currentVersion: '2.1.220',
      requiredVersion: '2.1.280',
      message: VERSION_ERROR,
      conversationId: 'conv-1',
    });
  });

  it('shows the prompt without a retry target for non-chat sources, and ignores other errors', () => {
    useCliUpdateStore.getState().initListener();
    mock.emit('chat:streamEvent', { type: 'error', message: 'Claude CLI run failed (error_max_turns)', source: 'chat' });
    expect(useCliUpdateStore.getState().prompt).toBeNull();

    mock.emit('chat:streamEvent', { type: 'error', message: VERSION_ERROR, source: 'revision', conversationId: 'conv-9' });
    expect(useCliUpdateStore.getState().prompt).toMatchObject({ kind: 'version-required', conversationId: null });
  });

  it('destroyListener detaches from the stream channel', () => {
    useCliUpdateStore.getState().initListener();
    expect(mock.listenerCount('chat:streamEvent')).toBe(1);
    useCliUpdateStore.getState().destroyListener();
    expect(mock.listenerCount('chat:streamEvent')).toBe(0);
  });

  it('checkReminder shows the reminder only when main says it is due', async () => {
    await useCliUpdateStore.getState().checkReminder();
    expect(useCliUpdateStore.getState().prompt).toBeNull();

    mock.claudeCli.checkUpdateReminder.mockResolvedValueOnce({ due: true, version: '2.1.318' });
    await useCliUpdateStore.getState().checkReminder();
    expect(useCliUpdateStore.getState().prompt).toEqual({ kind: 'reminder', version: '2.1.318' });
  });

  it('runUpdate stores the result; a bridge failure becomes a failed result', async () => {
    useCliUpdateStore.getState().reportError(VERSION_ERROR);
    await useCliUpdateStore.getState().runUpdate();
    expect(useCliUpdateStore.getState()).toMatchObject({ running: false, result: { status: 'up-to-date' } });

    mock.claudeCli.runUpdate.mockRejectedValueOnce(new Error('ipc down'));
    await useCliUpdateStore.getState().runUpdate();
    expect(useCliUpdateStore.getState().result).toMatchObject({ status: 'failed', output: 'ipc down' });
  });

  it('checkNow opens a manual prompt and runs the update', async () => {
    await useCliUpdateStore.getState().checkNow();
    expect(mock.claudeCli.runUpdate).toHaveBeenCalledTimes(1);
    expect(useCliUpdateStore.getState()).toMatchObject({ prompt: { kind: 'manual' }, result: { status: 'up-to-date' } });
  });
});
