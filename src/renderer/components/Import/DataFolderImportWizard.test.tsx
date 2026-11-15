import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import type { DataFolderBookSummary, DataFolderPreview } from '@domain/types';
import { DataFolderImportWizard } from './DataFolderImportWizard';
import { useDataFolderImportStore } from '../../stores/dataFolderImportStore';
import { useBookStore } from '../../stores/bookStore';
import { renderApp } from '../../../test/renderWithState';
import { resetStoresBeforeEach } from '../../../test/resetStores';

resetStoresBeforeEach(useDataFolderImportStore, useBookStore);

function book(slug: string, title: string, overrides: Partial<DataFolderBookSummary> = {}): DataFolderBookSummary {
  return {
    slug,
    title,
    author: 'A. Writer',
    wordCount: 81234,
    chapterCount: 30,
    conversationCount: 12,
    historyBytes: 37 * 1024 * 1024,
    folderExists: false,
    alreadyImported: false,
    ...overrides,
  };
}

const PREVIEW: DataFolderPreview = {
  sourcePath: '/old/Novel Engine',
  sourceSchemaVersion: 3,
  books: [book('the-long-road', 'The Long Road'), book('mine', 'Mine', { folderExists: true })],
  hasAuthorProfile: false,
  seriesSlugs: [],
};

describe('DataFolderImportWizard', () => {
  it('renders nothing while idle', () => {
    const { container } = renderApp(<DataFolderImportWizard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists books with sizes and a rename field for clashes, then imports', async () => {
    const commit = vi.fn(async () => ({
      imported: [{ from: 'the-long-road', to: 'the-long-road', title: 'The Long Road', conversations: 12, versions: 40 }],
      skipped: [{ slug: 'mine', reason: 'Skipped' }],
      warnings: ['Series "Saga": volume 2 was not imported, so it was left out.'],
    }));
    renderApp(<DataFolderImportWizard />, {
      bridge: {
        dataFolderImport: {
          selectFolder: vi.fn(async () => '/old/Novel Engine'),
          preview: vi.fn(async () => PREVIEW),
          commit,
        },
      },
    });

    await act(async () => {
      await useDataFolderImportStore.getState().startImport();
    });

    expect(screen.getByText('Source: /old/Novel Engine')).toBeInTheDocument();
    expect(screen.getAllByText(/81,234 words · 30 chapters · 12\s+chats · 37\.0 MB history/)).toHaveLength(2);
    expect(screen.getByLabelText('Import The Long Road')).toBeChecked();
    expect(screen.getByLabelText('Import Mine')).not.toBeChecked();
    expect(screen.getByLabelText('New title for Mine')).toHaveValue('Mine (imported)');
    expect(screen.queryByText(/author profile/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Imported 1 book.')).toBeInTheDocument();
    expect(screen.getByText('The Long Road — 12 chats, 40 versions')).toBeInTheDocument();
    expect(screen.getByText(/volume 2 was not imported/)).toBeInTheDocument();
    expect(screen.queryByText('Not imported:')).not.toBeInTheDocument();
  });

  it('disables Import when a selected clash has an empty title', () => {
    renderApp(<DataFolderImportWizard />, {
      stores: [
        [
          useDataFolderImportStore,
          {
            step: 'preview',
            preview: PREVIEW,
            choices: {
              'the-long-road': { selected: false, action: 'import', newTitle: 'The Long Road' },
              mine: { selected: true, action: 'rename', newTitle: '  ' },
            },
          },
        ],
      ],
    });
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('shows errors with a retry', () => {
    renderApp(<DataFolderImportWizard />, {
      stores: [[useDataFolderImportStore, { step: 'error', error: 'Not a Novel Engine data folder' }]],
    });
    expect(screen.getByText('Not a Novel Engine data folder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });
});
