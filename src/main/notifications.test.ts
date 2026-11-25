import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationManager } from './notifications';
import { makeFakeSettings } from '../test/fakes';
import { makeFakeHost, type FakeHost } from '../test/fakeHost';

let host: FakeHost;

function makeManager(enableNotifications = true): NotificationManager {
  return new NotificationManager(makeFakeSettings({ enableNotifications }), host);
}

/** Every notification the host was asked to show, in order. */
const shown = () => host.notify.mock.calls.map(([title, body]) => ({ title, body }));

beforeEach(() => {
  host = makeFakeHost();
});

describe('suppression rules', () => {
  it('shows a notification when enabled, supported, and the window is unfocused', async () => {
    await makeManager().notifyChatComplete('Spark');

    expect(host.notify).toHaveBeenCalledTimes(1);
  });

  it('suppresses when notifications are disabled in settings', async () => {
    await makeManager(false).notifyChatComplete('Spark');
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('suppresses when the OS does not support notifications', async () => {
    host.notificationsSupported.mockReturnValue(false);
    await makeManager().notifyChatComplete('Spark');
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('suppresses when a window is focused', async () => {
    host.isFocused.mockReturnValue(true);
    await makeManager().notifyChatComplete('Spark');
    expect(host.notify).not.toHaveBeenCalled();
  });
});

describe('message formatting', () => {
  it('notifyChatComplete uses the agent registry role, with and without a book title', async () => {
    const manager = makeManager();
    await manager.notifyChatComplete('Spark', 'My Novel');
    await manager.notifyChatComplete('Spark');

    expect(shown()[0]).toEqual({
      title: 'Spark is done',
      body: 'Story Pitch has finished responding — My Novel',
    });
    expect(shown()[1]).toEqual({
      title: 'Spark is done',
      body: 'Story Pitch has finished responding',
    });
  });

  it('notifyChatError truncates long messages to 117 chars + ellipsis', async () => {
    const manager = makeManager();
    await manager.notifyChatError('Verity', 'short failure');
    await manager.notifyChatError('Verity', 'x'.repeat(200));

    expect(shown()[0]).toEqual({
      title: 'Verity encountered an error',
      body: 'short failure',
    });
    expect(shown()[1].body).toBe('x'.repeat(117) + '...');
  });

  it('notifyBuildComplete pluralizes the format count', async () => {
    const manager = makeManager();
    await manager.notifyBuildComplete('My Novel', 1);
    await manager.notifyBuildComplete('My Novel', 3);

    expect(shown()[0].body).toBe('My Novel — exported 1 format');
    expect(shown()[1].body).toBe('My Novel — exported 3 formats');
  });

  it('revision notifications use fixed titles', async () => {
    const manager = makeManager();
    await manager.notifyRevisionSessionComplete('Session finished (tasks 1, 2)');
    await manager.notifyRevisionQueueDone();

    expect(shown()[0]).toEqual({
      title: 'Revision session complete',
      body: 'Session finished (tasks 1, 2)',
    });
    expect(shown()[1]).toEqual({
      title: 'Revision queue complete',
      body: 'All sessions have finished processing',
    });
  });
});
