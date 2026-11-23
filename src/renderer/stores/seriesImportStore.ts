import { create } from 'zustand';
import type {
  SeriesImportPreview,
  SeriesImportResult,
  SeriesImportTitleProblem,
  SeriesImportVolume,
} from '@domain/types';
import { ipcErrorMessage } from '../utils/bookTitle';

type SeriesImportStep =
  | 'idle'
  | 'loading'       // Previewing files
  | 'preview'       // Showing all volumes for review
  | 'importing'     // Committing all volumes
  | 'success'       // All done
  | 'error';

type SeriesImportState = {
  step: SeriesImportStep;
  preview: SeriesImportPreview | null;
  result: SeriesImportResult | null;
  error: string;

  // Editable fields
  seriesName: string;
  author: string;
  volumes: SeriesImportVolume[];
  existingSeriesSlug: string | null;
  /**
   * Why a volume's title can't be used, keyed by `SeriesImportVolume.index`:
   * it matches an existing book or an earlier volume (#79).
   */
  titleProblems: Record<number, string>;

  // Actions
  startImport: () => Promise<void>;
  /** Re-check every included volume's title; returns the problems found. */
  refreshTitleProblems: () => Promise<SeriesImportTitleProblem[]>;
  updateSeriesName: (name: string) => void;
  updateAuthor: (author: string) => void;
  updateVolumeTitle: (index: number, title: string) => void;
  toggleVolumeSkip: (index: number) => void;
  moveVolumeUp: (index: number) => void;
  moveVolumeDown: (index: number) => void;
  selectExistingSeries: (slug: string | null) => void;
  commitImport: () => Promise<void>;
  reset: () => void;
};

const initialState = {
  step: 'idle' as SeriesImportStep,
  preview: null as SeriesImportPreview | null,
  result: null as SeriesImportResult | null,
  error: '',
  seriesName: '',
  author: '',
  volumes: [] as SeriesImportVolume[],
  existingSeriesSlug: null as string | null,
  titleProblems: {} as Record<number, string>,
};

/** The title a volume is imported under (same fallback as commitImport). */
function volumeTitle(v: SeriesImportVolume): string {
  return v.preview.detectedTitle || `Volume ${v.volumeNumber}`;
}

/** Bumped per title check, so a slow, older answer can't overwrite a newer one. */
let titleCheckSeq = 0;

export const useSeriesImportStore = create<SeriesImportState>((set, get) => ({
  ...initialState,

  startImport: async () => {
    try {
      const filePaths = await window.novelEngine.seriesImport.selectFiles();
      if (!filePaths || filePaths.length === 0) return;

      set({ step: 'loading', error: '' });

      const preview = await window.novelEngine.seriesImport.preview(filePaths);

      // Fall back to settings author name
      const settingsAuthor = (await window.novelEngine.settings.load()).authorName;

      // Use first volume's detected author, or settings author
      const detectedAuthor =
        preview.volumes.find((v) => v.preview.detectedAuthor)?.preview.detectedAuthor ?? '';

      set({
        step: 'preview',
        preview,
        seriesName: preview.seriesName,
        author: detectedAuthor || settingsAuthor || '',
        volumes: [...preview.volumes],
        existingSeriesSlug: null,
        titleProblems: {},
      });
      await get().refreshTitleProblems();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      set({ step: 'error', error: message });
    }
  },

  refreshTitleProblems: async () => {
    const seq = ++titleCheckSeq;
    const active = get().volumes.filter((v) => !v.skipped);
    let problems: SeriesImportTitleProblem[];
    try {
      problems = await window.novelEngine.seriesImport.checkTitles(
        active.map((v) => ({ volumeNumber: v.volumeNumber, title: volumeTitle(v) })),
      );
    } catch (err) {
      // The commit re-checks in the main process, so a failed lookup isn't fatal
      console.error('Failed to check volume titles:', err);
      problems = [];
    }

    const step = get().step;
    if (seq === titleCheckSeq && (step === 'preview' || step === 'importing')) {
      const titleProblems: Record<number, string> = {};
      for (const problem of problems) {
        const vol = active.find((v) => v.volumeNumber === problem.volumeNumber);
        if (vol) titleProblems[vol.index] = problem.message;
      }
      set({ titleProblems });
    }
    return problems;
  },

  updateSeriesName: (seriesName) => set({ seriesName }),
  updateAuthor: (author) => set({ author }),

  updateVolumeTitle: (index, title) => {
    const volumes = [...get().volumes];
    const vol = volumes.find((v) => v.index === index);
    if (!vol) return;

    // Update the detected title in the preview (used for display and commit)
    vol.preview = {
      ...vol.preview,
      detectedTitle: title,
    };
    set({ volumes });
    void get().refreshTitleProblems();
  },

  toggleVolumeSkip: (index) => {
    const volumes = [...get().volumes];
    const vol = volumes.find((v) => v.index === index);
    if (!vol) return;
    vol.skipped = !vol.skipped;

    // Renumber non-skipped volumes
    let volumeNumber = 1;
    for (const v of volumes) {
      if (!v.skipped) {
        v.volumeNumber = volumeNumber++;
      }
    }
    set({ volumes });
    void get().refreshTitleProblems();
  },

  moveVolumeUp: (index) => {
    const volumes = [...get().volumes];
    const pos = volumes.findIndex((v) => v.index === index);
    if (pos <= 0) return;

    [volumes[pos - 1], volumes[pos]] = [volumes[pos], volumes[pos - 1]];

    // Renumber non-skipped volumes
    let volumeNumber = 1;
    for (const v of volumes) {
      if (!v.skipped) {
        v.volumeNumber = volumeNumber++;
      }
    }
    set({ volumes });
    void get().refreshTitleProblems();
  },

  moveVolumeDown: (index) => {
    const volumes = [...get().volumes];
    const pos = volumes.findIndex((v) => v.index === index);
    if (pos < 0 || pos >= volumes.length - 1) return;

    [volumes[pos], volumes[pos + 1]] = [volumes[pos + 1], volumes[pos]];

    // Renumber non-skipped volumes
    let volumeNumber = 1;
    for (const v of volumes) {
      if (!v.skipped) {
        v.volumeNumber = volumeNumber++;
      }
    }
    set({ volumes });
    void get().refreshTitleProblems();
  },

  selectExistingSeries: (slug) => {
    set({ existingSeriesSlug: slug });
  },

  commitImport: async () => {
    const { seriesName, author, volumes, existingSeriesSlug } = get();
    const activeVolumes = volumes.filter((v) => !v.skipped);

    if (activeVolumes.length === 0 || get().step === 'importing') return;

    // 'importing' first, so a second click can't start a second commit
    set({ step: 'importing', error: '' });

    // Back to the preview so the user can choose other titles (#79)
    const problems = await get().refreshTitleProblems();
    if (problems.length > 0) {
      set({ step: 'preview' });
      return;
    }

    try {
      const result = await window.novelEngine.seriesImport.commit({
        seriesName,
        existingSeriesSlug,
        author,
        volumes: activeVolumes.map((v) => ({
          volumeNumber: v.volumeNumber,
          title: volumeTitle(v),
          chapters: v.preview.chapters,
        })),
      });

      set({ step: 'success', result });
    } catch (err: unknown) {
      set({ step: 'error', error: ipcErrorMessage(err, 'Import failed') });
    }
  },

  reset: () => set({ ...initialState }),
}));
