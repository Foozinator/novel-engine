import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DEFAULT_SETTINGS, PROSE_FONT_SIZE_MAX } from '@domain/constants';
import { useProseZoom } from './useProseZoom';
import { useSettingsStore } from '../stores/settingsStore';
import { installNovelEngineMock, type NovelEngineMock } from '../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../test/resetStores';

resetStoresBeforeEach(useSettingsStore);

const size = (): number | undefined => useSettingsStore.getState().settings?.proseFontSize;

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, ctrlKey, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

function key(k: string, ctrlKey = true): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, ctrlKey, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe('useProseZoom', () => {
  let mock: NovelEngineMock;

  beforeEach(() => {
    vi.useFakeTimers();
    mock = installNovelEngineMock();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    renderHook(() => useProseZoom());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Ctrl + wheel up enlarges and wheel down shrinks the prose, cancelling the default', () => {
    const up = wheel(-100);
    expect(up.defaultPrevented).toBe(true);
    expect(size()).toBe(17.5);
    wheel(100);
    wheel(100);
    expect(size()).toBe(15.5);
  });

  it('ignores the wheel without Ctrl', () => {
    const event = wheel(-100, false);
    expect(event.defaultPrevented).toBe(false);
    expect(size()).toBe(16.5);
  });

  it('Ctrl + = / - step and Ctrl + 0 resets', () => {
    key('=');
    key('+');
    expect(size()).toBe(18.5);
    key('-');
    expect(size()).toBe(17.5);
    key('0');
    expect(size()).toBe(16.5);
    key('=', false);
    expect(size()).toBe(16.5);
  });

  it('clamps at the maximum', () => {
    for (let i = 0; i < 40; i++) wheel(-100);
    expect(size()).toBe(PROSE_FONT_SIZE_MAX);
  });

  it('persists once per burst, after a pause', () => {
    wheel(-100);
    wheel(-100);
    wheel(-100);
    expect(mock.settings.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(mock.settings.update).toHaveBeenCalledTimes(1);
    expect(mock.settings.update).toHaveBeenCalledWith({ proseFontSize: 19.5 });
  });
});
