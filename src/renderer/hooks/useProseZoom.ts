import { useEffect } from 'react';
import {
  PROSE_FONT_SIZE_DEFAULT,
  PROSE_FONT_SIZE_STEP,
  clampProseFontSize,
} from '@domain/constants';
import { useSettingsStore } from '../stores/settingsStore';

/** Delay before a run of size changes is written to settings.json. */
const PERSIST_DELAY_MS = 400;

/**
 * App-wide reading-size controls for typeset prose (ProseViewer):
 * Ctrl/Cmd + mouse wheel, Ctrl/Cmd + `=`/`+` and `-` step the size,
 * Ctrl/Cmd + `0` resets it. The store updates at once so the text resizes
 * live; the write to settings is debounced so a wheel spin is one write.
 */
export function useProseZoom(): void {
  useEffect(() => {
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const apply = (next: (current: number) => number): void => {
      const { settings } = useSettingsStore.getState();
      if (!settings) return;
      const size = clampProseFontSize(next(settings.proseFontSize ?? PROSE_FONT_SIZE_DEFAULT));
      if (size === settings.proseFontSize) return;
      useSettingsStore.setState({ settings: { ...settings, proseFontSize: size } });
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        window.novelEngine.settings.update({ proseFontSize: size }).catch((err: unknown) => {
          console.error('Failed to save prose font size:', err);
        });
      }, PERSIST_DELAY_MS);
    };

    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? PROSE_FONT_SIZE_STEP : -PROSE_FONT_SIZE_STEP;
      apply((s) => s + step);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        apply((s) => s + PROSE_FONT_SIZE_STEP);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        apply((s) => s - PROSE_FONT_SIZE_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        apply(() => PROSE_FONT_SIZE_DEFAULT);
      }
    };

    // Non-passive so preventDefault() stops Chromium's own Ctrl+wheel handling.
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      if (persistTimer) clearTimeout(persistTimer);
    };
  }, []);
}
