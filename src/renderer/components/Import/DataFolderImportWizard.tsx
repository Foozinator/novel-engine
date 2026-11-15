import { useDataFolderImportStore, isBlocked } from '../../stores/dataFolderImportStore';
import { useBookStore } from '../../stores/bookStore';
import { useSeriesStore } from '../../stores/seriesStore';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const secondaryButton =
  'px-3 py-1.5 text-sm rounded border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800';
const primaryButton =
  'px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed';

/** Import books (folders plus chats and version history) from another data folder (#37). */
export function DataFolderImportWizard() {
  const step = useDataFolderImportStore((s) => s.step);
  const preview = useDataFolderImportStore((s) => s.preview);
  const choices = useDataFolderImportStore((s) => s.choices);
  const copyAuthorProfile = useDataFolderImportStore((s) => s.copyAuthorProfile);
  const copySeries = useDataFolderImportStore((s) => s.copySeries);
  const result = useDataFolderImportStore((s) => s.result);
  const error = useDataFolderImportStore((s) => s.error);
  const toggleBook = useDataFolderImportStore((s) => s.toggleBook);
  const setAllSelected = useDataFolderImportStore((s) => s.setAllSelected);
  const setNewTitle = useDataFolderImportStore((s) => s.setNewTitle);
  const setCopyAuthorProfile = useDataFolderImportStore((s) => s.setCopyAuthorProfile);
  const setCopySeries = useDataFolderImportStore((s) => s.setCopySeries);
  const commitImport = useDataFolderImportStore((s) => s.commitImport);
  const startImport = useDataFolderImportStore((s) => s.startImport);
  const reset = useDataFolderImportStore((s) => s.reset);

  if (step === 'idle') return null;

  const books = preview?.books ?? [];
  const selected = books.filter((b) => choices[b.slug]?.selected);
  const missingTitle = selected.some((b) => choices[b.slug].action === 'rename' && !choices[b.slug].newTitle.trim());
  const canCommit = (selected.length > 0 || copyAuthorProfile) && !missingTitle;

  const handleDone = async () => {
    const first = result?.imported[0];
    reset();
    void useSeriesStore.getState().loadSeries();
    if (first) await useBookStore.getState().setActiveBook(first.to);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[680px] max-h-[80vh] rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Import from another Novel Engine folder</h2>
          {preview && (
            <p className="text-xs text-zinc-500 mt-1 break-all" title={preview.sourcePath}>
              Source: {preview.sourcePath}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="mt-4 text-sm text-zinc-500">Reading the folder…</p>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="px-5 py-4 space-y-4">
              <p className="text-xs text-zinc-500">
                Books are copied with their chats and version history. The source folder is not changed. For an exact
                copy, close any Novel Engine that is using it first.
              </p>

              {books.length === 0 ? (
                <p className="text-sm text-zinc-500">No books found in this folder.</p>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                      Books ({selected.length} of {books.length} selected)
                    </span>
                    <span className="flex gap-3 text-xs">
                      <button className="text-blue-600 hover:underline" onClick={() => setAllSelected(true)}>
                        Select all
                      </button>
                      <button className="text-blue-600 hover:underline" onClick={() => setAllSelected(false)}>
                        None
                      </button>
                    </span>
                  </div>
                  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded border border-zinc-200 dark:border-zinc-800">
                    {books.map((b) => {
                      const c = choices[b.slug];
                      const blocked = isBlocked(b);
                      return (
                        <li key={b.slug} className="px-3 py-2">
                          <label className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              aria-label={`Import ${b.title}`}
                              checked={!!c?.selected}
                              disabled={blocked}
                              onChange={() => toggleBook(b.slug)}
                              className="mt-1"
                            />
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm text-zinc-900 dark:text-zinc-100 truncate">{b.title}</span>
                              <span className="block text-xs text-zinc-500">
                                {b.author && `${b.author} · `}
                                {b.wordCount.toLocaleString()} words · {b.chapterCount} chapters · {b.conversationCount}{' '}
                                chats · {formatBytes(b.historyBytes)} history
                              </span>
                            </span>
                          </label>
                          {blocked && (
                            <p className="ml-7 mt-1 text-xs text-zinc-500">Already imported: its chats are already here.</p>
                          )}
                          {!blocked && b.folderExists && (
                            <div className="ml-7 mt-1 space-y-1">
                              <p className="text-xs text-amber-700 dark:text-amber-300">
                                A book in folder “{b.slug}” already exists here. Import it under a new title, or leave it
                                unchecked to skip it.
                              </p>
                              <input
                                type="text"
                                aria-label={`New title for ${b.title}`}
                                value={c?.newTitle ?? ''}
                                onChange={(e) => setNewTitle(b.slug, e.target.value)}
                                className="w-full px-2 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="space-y-1">
                {preview.seriesSlugs.length > 0 && (
                  <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input type="checkbox" checked={copySeries} onChange={(e) => setCopySeries(e.target.checked)} />
                    Copy series that include these books
                  </label>
                )}
                {preview.hasAuthorProfile && (
                  <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      checked={copyAuthorProfile}
                      onChange={(e) => setCopyAuthorProfile(e.target.checked)}
                    />
                    Copy the author profile (only if yours is still empty)
                  </label>
                )}
              </div>
            </div>
          )}

          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="mt-4 text-sm text-zinc-500">Importing books…</p>
            </div>
          )}

          {step === 'success' && result && (
            <div className="px-5 py-4 space-y-3 text-sm">
              <p className="text-zinc-900 dark:text-zinc-100">
                Imported {result.imported.length} {result.imported.length === 1 ? 'book' : 'books'}.
              </p>
              {result.imported.length > 0 && (
                <ul className="list-disc ml-5 text-zinc-700 dark:text-zinc-300">
                  {result.imported.map((i) => (
                    <li key={i.to}>
                      {i.title} — {i.conversations} chats, {i.versions} versions
                    </li>
                  ))}
                </ul>
              )}
              {result.skipped.some((s) => s.reason !== 'Skipped') && (
                <div>
                  <p className="text-zinc-700 dark:text-zinc-300">Not imported:</p>
                  <ul className="list-disc ml-5 text-zinc-500">
                    {result.skipped
                      .filter((s) => s.reason !== 'Skipped')
                      .map((s) => (
                        <li key={s.slug}>
                          {s.slug}: {s.reason}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {result.warnings.length > 0 && (
                <ul className="list-disc ml-5 text-amber-700 dark:text-amber-300">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {step === 'error' && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          {step === 'preview' && (
            <>
              <button onClick={reset} className={secondaryButton}>
                Cancel
              </button>
              <button onClick={() => void commitImport()} disabled={!canCommit} className={primaryButton}>
                Import
              </button>
            </>
          )}
          {step === 'success' && (
            <button onClick={() => void handleDone()} className={primaryButton}>
              Done
            </button>
          )}
          {step === 'error' && (
            <>
              <button
                onClick={() => {
                  reset();
                  void startImport();
                }}
                className={secondaryButton}
              >
                Try Again
              </button>
              <button onClick={reset} className={primaryButton}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
