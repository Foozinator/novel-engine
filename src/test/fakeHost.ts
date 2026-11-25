import { vi, type Mock } from 'vitest';
import type { PushChannel } from '@domain/channels';
import type { CallContext, EventSink, HostAdapter } from '../main/host';

/** `HostAdapter` where every method is a `vi.fn` with an inert default (dialogs cancelled). */
export type FakeHost = { [K in keyof HostAdapter]: ReturnType<typeof vi.fn> & HostAdapter[K] };

export function makeFakeHost(): FakeHost {
  return {
    pickFiles: vi.fn(async () => null),
    saveFile: vi.fn(async () => null),
    confirm: vi.fn(async () => 0),
    showError: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    notify: vi.fn(),
    isFocused: vi.fn(() => false),
    notificationsSupported: vi.fn(() => true),
    focusApp: vi.fn(),
    setTheme: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    windowControl: vi.fn(),
    isWindowMaximized: vi.fn(() => false),
  } as FakeHost;
}

export type FakeEvents = EventSink & { broadcast: Mock<(channel: PushChannel, ...args: unknown[]) => void> };

export function makeFakeEvents(): FakeEvents {
  return { broadcast: vi.fn<(channel: PushChannel, ...args: unknown[]) => void>() as FakeEvents['broadcast'] };
}

/** A call context whose `reply` is recorded. */
export function makeFakeContext(): CallContext & { reply: ReturnType<typeof vi.fn> & CallContext["reply"] } {
  return { sender: {}, reply: vi.fn() as ReturnType<typeof vi.fn> & CallContext["reply"] };
}
