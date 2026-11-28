import { create } from 'zustand';
import type { DetectedChapter, ImportPreview, ImportResult, SourceGenerationStep } from '@domain/types';
import { findTitleConflictMessage, ipcErrorMessage } from '../utils/bookTitle';

type ImportStep = 'idle' | 'loading' | 'preview' | 'importing' | 'success' | 'generating' | 'generated' | 'error';

type ImportState = {
  step: ImportStep;
  preview: ImportPreview | null;
  result: ImportResult | null;
  error: string;
  title: string;
  /** Why `title` can't be used: it matches an existing book (#79). '' when free. */
  titleConflict: string;
  author: string;
  chapters: DetectedChapter[];
  generationSteps: SourceGenerationStep[];
  generationCleanup: (() => void) | null;

  startImport: () => Promise<void>;
  updateTitle: (title: string) => void;
  updateAuthor: (author: string) => void;
  renameChapter: (index: number, newTitle: string) => void;
  mergeWithNext: (index: number) => void;
  removeChapter: (index: number) => void;
  commitImport: () => Promise<void>;
  startGeneration: () => Promise<void>;
  retryFailedGeneration: () => Promise<void>;
  runGeneration: (stepIndexes?: number[]) => Promise<void>;
  reset: () => void;
};

const initialState = {
  step: 'idle' as ImportStep,
  preview: null as ImportPreview | null,
  result: null as ImportResult | null,
  error: '',
  title: '',
  titleConflict: '',
  author: '',
  chapters: [] as DetectedChapter[],
  generationSteps: [] as SourceGenerationStep[],
  generationCleanup: null as (() => void) | null,
};

export const useImportStore = create<ImportState>((set, get) => ({
  ...initialState,

  startImport: async () => {
    try {
      const filePath = await window.novelEngine.import.selectFile();
      if (!filePath) return; // User cancelled file dialog

      set({ step: 'loading', error: '' });

      const data = await window.novelEngine.import.preview(filePath);

      // Fall back to settings author name if no author detected in manuscript
      const settingsAuthor = (await window.novelEngine.settings.load()).authorName;

      // A newer draft of a story in the library is the likely collision, so
      // say so before the user reviews the chapters (#79).
      const title = data.detectedTitle || 'Untitled';
      const titleConflict = (await findTitleConflictMessage(title)) ?? '';

      set({
        step: 'preview',
        preview: data,
        title,
        titleConflict,
        author: data.detectedAuthor || settingsAuthor || '',
        chapters: [...data.chapters],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ step: 'error', error: message });
    }
  },

  updateTitle: (title: string) => set({ title, titleConflict: '' }),

  updateAuthor: (author: string) => set({ author }),

  renameChapter: (index: number, newTitle: string) => {
    const chapters = [...get().chapters];
    if (index < 0 || index >= chapters.length) return;
    chapters[index] = { ...chapters[index], title: newTitle };
    set({ chapters });
  },

  mergeWithNext: (index: number) => {
    const chapters = [...get().chapters];
    if (index < 0 || index >= chapters.length - 1) return;

    const current = chapters[index];
    const next = chapters[index + 1];

    const mergedContent = current.content + '\n\n' + next.content;
    const mergedWordCount = current.wordCount + next.wordCount;

    const merged: DetectedChapter = {
      ...current,
      content: mergedContent,
      wordCount: mergedWordCount,
      endLine: next.endLine,
    };

    chapters.splice(index, 2, merged);

    // Recalculate indices
    const reindexed = chapters.map((ch, i) => ({ ...ch, index: i }));
    set({ chapters: reindexed });
  },

  removeChapter: (index: number) => {
    const chapters = [...get().chapters];
    if (chapters.length <= 1) return; // Don't remove the last chapter
    if (index < 0 || index >= chapters.length) return;

    const removed = chapters[index];

    // Append content to previous chapter (or discard if first)
    if (index > 0) {
      const prev = chapters[index - 1];
      chapters[index - 1] = {
        ...prev,
        content: prev.content + '\n\n' + removed.content,
        wordCount: prev.wordCount + removed.wordCount,
        endLine: removed.endLine,
      };
    }

    chapters.splice(index, 1);

    // Recalculate indices
    const reindexed = chapters.map((ch, i) => ({ ...ch, index: i }));
    set({ chapters: reindexed });
  },

  commitImport: async () => {
    const { title, author, chapters, step } = get();
    if (step === 'importing') return;

    // 'importing' first, so a second click can't start a second commit
    set({ step: 'importing', error: '' });

    // Back to the preview so the user can choose another title (#79)
    const titleConflict = await findTitleConflictMessage(title);
    if (titleConflict) {
      set({ step: 'preview', titleConflict });
      return;
    }

    try {
      const result = await window.novelEngine.import.commit({ title, author, chapters });
      set({ step: 'success', result });
    } catch (err: unknown) {
      set({ step: 'error', error: ipcErrorMessage(err, 'Import failed') });
    }
  },

  startGeneration: () => get().runGeneration(),

  retryFailedGeneration: () => {
    const failed = get().generationSteps.filter((s) => s.status === 'error').map((s) => s.index);
    return get().runGeneration(failed);
  },

  runGeneration: async (stepIndexes?: number[]) => {
    const { result, generationCleanup } = get();
    if (!result) return;
    if (generationCleanup) generationCleanup();

    set({ step: 'generating', ...(stepIndexes ? {} : { generationSteps: [] }) });

    const cleanup = window.novelEngine.import.onGenerationProgress((event) => {
      if (event.type === 'started') {
        // A retry announces only its own steps; keep the others' results
        set((s) => ({
          generationSteps: [
            ...s.generationSteps.filter((old) => !event.steps.some((n) => n.index === old.index)),
            ...event.steps,
          ].sort((a, b) => a.index - b.index),
        }));
      } else if (event.type === 'step-started') {
        set((s) => ({
          generationSteps: s.generationSteps.map((step) =>
            step.index === event.index ? { ...step, status: 'running' as const } : step
          ),
        }));
      } else if (event.type === 'step-done') {
        set((s) => ({
          generationSteps: s.generationSteps.map((step) =>
            step.index === event.index ? { ...step, status: 'done' as const } : step
          ),
        }));
      } else if (event.type === 'step-error') {
        set((s) => ({
          generationSteps: s.generationSteps.map((step) =>
            step.index === event.index ? { ...step, status: 'error' as const, error: event.message } : step
          ),
        }));
      } else if (event.type === 'done') {
        set({ step: 'generated' });
      } else if (event.type === 'error') {
        set({ step: 'error', error: event.message });
      }
    });

    set({ generationCleanup: cleanup });

    try {
      await window.novelEngine.import.generateSources(result.bookSlug, stepIndexes);
    } catch (err: unknown) {
      set({ step: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  reset: () => {
    const { generationCleanup } = get();
    if (generationCleanup) generationCleanup();
    set({ ...initialState });
  },
}));
