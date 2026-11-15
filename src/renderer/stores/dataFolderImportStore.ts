import { create } from 'zustand';
import type { DataFolderBookAction, DataFolderImportResult, DataFolderPreview } from '@domain/types';

type DataFolderImportStep = 'idle' | 'loading' | 'preview' | 'importing' | 'success' | 'error';

/** The user's choice for one source book. */
export type DataFolderBookChoice = {
  selected: boolean;
  action: Exclude<DataFolderBookAction, 'skip'>;
  newTitle: string;
};

type DataFolderImportState = {
  step: DataFolderImportStep;
  preview: DataFolderPreview | null;
  choices: Record<string, DataFolderBookChoice>;
  copyAuthorProfile: boolean;
  copySeries: boolean;
  result: DataFolderImportResult | null;
  error: string;

  startImport: () => Promise<void>;
  toggleBook: (slug: string) => void;
  setAllSelected: (selected: boolean) => void;
  setNewTitle: (slug: string, title: string) => void;
  setCopyAuthorProfile: (value: boolean) => void;
  setCopySeries: (value: boolean) => void;
  commitImport: () => Promise<void>;
  reset: () => void;
};

const initialState = {
  step: 'idle' as DataFolderImportStep,
  preview: null as DataFolderPreview | null,
  choices: {} as Record<string, DataFolderBookChoice>,
  copyAuthorProfile: false,
  copySeries: false,
  result: null as DataFolderImportResult | null,
  error: '',
};

/** Books that can't be imported: already here with their chats. */
export function isBlocked(book: DataFolderPreview['books'][number]): boolean {
  return book.alreadyImported;
}

export const useDataFolderImportStore = create<DataFolderImportState>((set, get) => ({
  ...initialState,

  startImport: async () => {
    try {
      const folder = await window.novelEngine.dataFolderImport.selectFolder();
      if (!folder) return; // cancelled

      set({ ...initialState, step: 'loading' });
      const preview = await window.novelEngine.dataFolderImport.preview(folder);

      const choices: Record<string, DataFolderBookChoice> = {};
      for (const b of preview.books) {
        choices[b.slug] = {
          // A clashing folder needs a new name before it can import; leave it unchecked.
          selected: !isBlocked(b) && !b.folderExists,
          action: b.folderExists ? 'rename' : 'import',
          newTitle: b.folderExists ? `${b.title} (imported)` : b.title,
        };
      }
      set({
        step: 'preview',
        preview,
        choices,
        copySeries: preview.seriesSlugs.length > 0,
        copyAuthorProfile: preview.hasAuthorProfile,
      });
    } catch (err: unknown) {
      set({ step: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleBook: (slug) => {
    const { choices, preview } = get();
    const book = preview?.books.find((b) => b.slug === slug);
    if (!choices[slug] || !book || isBlocked(book)) return;
    set({ choices: { ...choices, [slug]: { ...choices[slug], selected: !choices[slug].selected } } });
  },

  setAllSelected: (selected) => {
    const { choices, preview } = get();
    if (!preview) return;
    const next = { ...choices };
    for (const b of preview.books) {
      if (!isBlocked(b)) next[b.slug] = { ...next[b.slug], selected };
    }
    set({ choices: next });
  },

  setNewTitle: (slug, title) => {
    const { choices } = get();
    if (!choices[slug]) return;
    set({ choices: { ...choices, [slug]: { ...choices[slug], newTitle: title } } });
  },

  setCopyAuthorProfile: (value) => set({ copyAuthorProfile: value }),
  setCopySeries: (value) => set({ copySeries: value }),

  commitImport: async () => {
    const { preview, choices, copyAuthorProfile, copySeries } = get();
    if (!preview) return;
    set({ step: 'importing', error: '' });
    try {
      const result = await window.novelEngine.dataFolderImport.commit({
        sourcePath: preview.sourcePath,
        books: preview.books.map((b) => {
          const c = choices[b.slug];
          if (!c?.selected) return { slug: b.slug, action: 'skip' as const };
          return c.action === 'rename'
            ? { slug: b.slug, action: 'rename' as const, newTitle: c.newTitle }
            : { slug: b.slug, action: 'import' as const };
        }),
        copyAuthorProfile,
        copySeries,
      });
      set({ step: 'success', result });
    } catch (err: unknown) {
      set({ step: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  reset: () => set({ ...initialState }),
}));
