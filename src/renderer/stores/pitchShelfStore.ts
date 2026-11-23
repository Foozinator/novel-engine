import { create } from 'zustand';
import type { ShelvedPitchMeta, ShelvedPitch } from '@domain/types';
import { findTitleConflictMessage, ipcErrorMessage, type PitchToBookResult } from '../utils/bookTitle';

type PitchShelfState = {
  pitches: ShelvedPitchMeta[];
  loading: boolean;
  error: string | null;

  // Preview state
  previewPitch: ShelvedPitch | null;
  previewLoading: boolean;

  // Actions
  loadPitches: () => Promise<void>;
  previewPitchBySlug: (slug: string) => Promise<void>;
  closePreview: () => void;
  /**
   * Create a book from a shelved pitch, titled `title` or the pitch's title.
   * A taken title (#79) is reported with `takenTitle` and nothing is created.
   */
  restorePitch: (slug: string, title?: string) => Promise<PitchToBookResult>;
  deletePitch: (slug: string) => Promise<void>;
  shelveCurrentPitch: (bookSlug: string, logline?: string) => Promise<void>;
};

export const usePitchShelfStore = create<PitchShelfState>((set, get) => ({
  pitches: [],
  loading: false,
  error: null,
  previewPitch: null,
  previewLoading: false,

  loadPitches: async () => {
    set({ loading: true, error: null });
    try {
      const pitches = await window.novelEngine.pitches.list();
      set({ pitches, loading: false });
    } catch (err) {
      console.error('Failed to load shelved pitches:', err);
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load pitches',
      });
    }
  },

  previewPitchBySlug: async (slug: string) => {
    set({ previewLoading: true });
    try {
      const pitch = await window.novelEngine.pitches.read(slug);
      set({ previewPitch: pitch, previewLoading: false });
    } catch (err) {
      console.error('Failed to load pitch preview:', err);
      set({ previewLoading: false });
    }
  },

  closePreview: () => {
    set({ previewPitch: null });
  },

  restorePitch: async (slug: string, title?: string) => {
    try {
      // Check the title the book would get, so a taken one can be changed first
      const bookTitle =
        title?.trim() ||
        get().pitches.find((p) => p.slug === slug)?.title ||
        (await window.novelEngine.pitches.read(slug)).title;
      const conflict = await findTitleConflictMessage(bookTitle);
      if (conflict) return { ok: false, message: conflict, takenTitle: bookTitle };

      const meta = title?.trim()
        ? await window.novelEngine.pitches.restore(slug, title.trim())
        : await window.novelEngine.pitches.restore(slug);
      // Remove from local state immediately
      set((state) => ({
        pitches: state.pitches.filter((p) => p.slug !== slug),
        previewPitch: null,
      }));
      return { ok: true, slug: meta.slug };
    } catch (err) {
      console.error('Failed to restore pitch:', err);
      return { ok: false, message: ipcErrorMessage(err, 'Could not create the book') };
    }
  },

  deletePitch: async (slug: string) => {
    await window.novelEngine.pitches.delete(slug);
    set((state) => ({
      pitches: state.pitches.filter((p) => p.slug !== slug),
    }));
  },

  shelveCurrentPitch: async (bookSlug: string, logline?: string) => {
    const newPitch = await window.novelEngine.pitches.shelve(bookSlug, logline);
    set((state) => ({
      pitches: [newPitch, ...state.pitches],
    }));
  },
}));
