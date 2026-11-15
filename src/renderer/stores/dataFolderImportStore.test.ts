import { describe, it, expect, beforeEach } from 'vitest';
import type { DataFolderBookSummary, DataFolderPreview } from '@domain/types';
import { useDataFolderImportStore } from './dataFolderImportStore';
import { installNovelEngineMock, type NovelEngineMock } from '../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../test/resetStores';

resetStoresBeforeEach(useDataFolderImportStore);

function book(slug: string, overrides: Partial<DataFolderBookSummary> = {}): DataFolderBookSummary {
  return {
    slug,
    title: slug.toUpperCase(),
    author: '',
    wordCount: 100,
    chapterCount: 2,
    conversationCount: 1,
    historyBytes: 2048,
    folderExists: false,
    alreadyImported: false,
    ...overrides,
  };
}

function makePreview(overrides: Partial<DataFolderPreview> = {}): DataFolderPreview {
  return {
    sourcePath: '/old/Novel Engine',
    sourceSchemaVersion: 3,
    books: [book('fresh'), book('clash', { folderExists: true }), book('done', { folderExists: true, alreadyImported: true })],
    hasAuthorProfile: true,
    seriesSlugs: ['saga'],
    ...overrides,
  };
}

let mock: NovelEngineMock;

beforeEach(() => {
  mock = installNovelEngineMock();
});

async function toPreview(preview = makePreview()): Promise<void> {
  mock.dataFolderImport.selectFolder.mockResolvedValue('/old/Novel Engine');
  mock.dataFolderImport.preview.mockResolvedValue(preview);
  await useDataFolderImportStore.getState().startImport();
}

describe('dataFolderImportStore', () => {
  it('stays idle when the folder picker is cancelled', async () => {
    await useDataFolderImportStore.getState().startImport();
    expect(useDataFolderImportStore.getState().step).toBe('idle');
    expect(mock.dataFolderImport.preview).not.toHaveBeenCalled();
  });

  it('preselects free books, proposes a new title for clashes, and blocks re-imports', async () => {
    await toPreview();
    const s = useDataFolderImportStore.getState();
    expect(s.step).toBe('preview');
    expect(s.choices.fresh).toEqual({ selected: true, action: 'import', newTitle: 'FRESH' });
    expect(s.choices.clash).toEqual({ selected: false, action: 'rename', newTitle: 'CLASH (imported)' });
    expect(s.choices.done.selected).toBe(false);
    expect(s.copySeries).toBe(true);
    expect(s.copyAuthorProfile).toBe(true);

    s.toggleBook('done');
    expect(useDataFolderImportStore.getState().choices.done.selected).toBe(false);
    s.setAllSelected(true);
    const after = useDataFolderImportStore.getState().choices;
    expect([after.fresh.selected, after.clash.selected, after.done.selected]).toEqual([true, true, false]);
  });

  it('commits import, rename and skip actions', async () => {
    await toPreview();
    const s = useDataFolderImportStore.getState();
    s.toggleBook('clash');
    s.setNewTitle('clash', 'Clash Two');
    s.setCopyAuthorProfile(false);
    mock.dataFolderImport.commit.mockResolvedValue({ imported: [], skipped: [], warnings: [] });

    await useDataFolderImportStore.getState().commitImport();

    expect(mock.dataFolderImport.commit).toHaveBeenCalledWith({
      sourcePath: '/old/Novel Engine',
      books: [
        { slug: 'fresh', action: 'import' },
        { slug: 'clash', action: 'rename', newTitle: 'Clash Two' },
        { slug: 'done', action: 'skip' },
      ],
      copyAuthorProfile: false,
      copySeries: true,
    });
    expect(useDataFolderImportStore.getState().step).toBe('success');
  });

  it('surfaces preview and commit errors', async () => {
    mock.dataFolderImport.selectFolder.mockResolvedValue('/nope');
    mock.dataFolderImport.preview.mockRejectedValue(new Error('Not a Novel Engine data folder'));
    await useDataFolderImportStore.getState().startImport();
    expect(useDataFolderImportStore.getState()).toMatchObject({ step: 'error', error: 'Not a Novel Engine data folder' });

    await toPreview();
    mock.dataFolderImport.commit.mockRejectedValue(new Error('boom'));
    await useDataFolderImportStore.getState().commitImport();
    expect(useDataFolderImportStore.getState()).toMatchObject({ step: 'error', error: 'boom' });
  });
});
