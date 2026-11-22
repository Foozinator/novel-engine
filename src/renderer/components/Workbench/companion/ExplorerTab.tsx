import { useEffect, useState } from 'react';
import { isTextFilePath } from '@domain/constants';
import type { FileEntry } from '@domain/types';
import { useBookStore } from '../../../stores/bookStore';
import { useViewStore } from '../../../stores/viewStore';
import { FileBrowser } from '../../Files/FileBrowser';
import { Icon } from '../../common/Icon';
import { ProseViewer, useBookFile } from '../../common/ProseViewer';
import { VersionHistoryModal } from '../../common/VersionHistoryModal';

/** Verity-authored chapter drafts (body chapters 02+) are read-only in the UI. */
function isVerityDraft(path: string): boolean {
  const match = path.match(/^chapters\/(\d+)-[^/]+\/draft\.md$/);
  return match !== null && parseInt(match[1], 10) >= 2;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PNG file", or "File" when the name has no extension. */
function describeFileType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(dot + 1).toUpperCase()} file` : 'File';
}

/**
 * Stand-in for the preview of an image or other non-text file. Reading it as
 * text shows garbage, and saving that text back destroys the file (#83).
 */
function NonTextFileInfo({ fileName, size }: { fileName: string; size: number | null }): React.ReactElement {
  return (
    <div className="mx-auto max-w-sm pt-8 text-center">
      <div className="truncate text-sm text-ne-ink" title={fileName}>
        {fileName}
      </div>
      <div className="mt-1 text-xs text-ne-ink-dim">
        {describeFileType(fileName)}
        {size !== null && ` · ${formatBytes(size)}`}
      </div>
      <p className="mt-4 text-xs text-ne-ink-faint">
        This isn't a text file, so it can't be previewed or edited here.
      </p>
    </div>
  );
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Full book-directory explorer: embeds FileBrowser with a breadcrumb, and
 * previews selected files read-only in ProseViewer. The Edit affordance
 * hands off to the manuscript editor (fully wired in SESSION-11).
 */
export function ExplorerTab(): React.ReactElement {
  const activeSlug = useBookStore((s) => s.activeSlug);
  const { navigate } = useViewStore();
  const [dirPath, setDirPath] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  /** Size of the previewed file, from its listing entry (null when unknown). */
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);

  // Book switch → back to the root listing.
  useEffect(() => {
    setDirPath('');
    setPreviewPath(null);
    setHistoryPath(null);
  }, [activeSlug]);

  const isTextPreview = previewPath !== null && isTextFilePath(previewPath);
  // Non-text files are never read: the bridge decodes everything as UTF-8.
  const { content, loading, error } = useBookFile(activeSlug, isTextPreview ? previewPath : null);

  const handleFileSelect = (path: string, entry?: FileEntry): void => {
    setPreviewPath(path);
    setPreviewSize(entry?.size ?? null);
  };

  // ── File preview ──────────────────────────────────────────────────────────
  if (previewPath) {
    const isMarkdown = previewPath.endsWith('.md');
    const isJson = previewPath.endsWith('.json');
    const fileName = previewPath.split('/').pop() ?? previewPath;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-ne-line-soft px-3 py-2">
          <button
            onClick={() => setPreviewPath(null)}
            title="Back to files"
            className="flex items-center gap-1 rounded-md border border-ne-line bg-ne-bg2 px-2 py-1 text-[11px] text-ne-ink-dim transition-colors hover:border-ne-brass/50 hover:text-ne-ink"
          >
            <Icon name="chevronRight" size={10} strokeWidth={2} className="rotate-180" />
            Files
          </button>
          <span
            className="min-w-0 flex-1 truncate font-ne-mono text-[10.5px] text-ne-ink-dim"
            title={previewPath}
          >
            {previewPath}
          </span>
          {isTextPreview && (
            <button
              onClick={() => setHistoryPath(previewPath)}
              title="Version history"
              className="flex items-center gap-1 rounded-md border border-ne-line bg-ne-bg2 px-2 py-1 text-[11px] text-ne-ink-dim transition-colors hover:border-ne-brass/50 hover:text-ne-ink"
            >
              <Icon name="history" size={10} strokeWidth={2} />
              History
            </button>
          )}
          {isTextPreview && !isVerityDraft(previewPath) && (
            <button
              onClick={() => navigate('manuscript', { filePath: previewPath, manuscriptMode: 'editor' })}
              title={`Edit ${fileName} in the manuscript editor`}
              className="flex items-center gap-1 rounded-md border border-ne-line bg-ne-bg2 px-2 py-1 text-[11px] text-ne-ink-dim transition-colors hover:border-ne-brass/50 hover:text-ne-ink"
            >
              <Icon name="pencil" size={10} strokeWidth={2} />
              Edit
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 pb-14">
          {!isTextPreview ? (
            <NonTextFileInfo fileName={fileName} size={previewSize} />
          ) : error ? (
            <div className="pt-8 text-center text-sm text-ne-ink-faint">{error}</div>
          ) : loading ? (
            <div className="pt-8 text-center text-sm text-ne-ink-faint">Loading…</div>
          ) : (
            <ProseViewer content={isJson ? formatJson(content) : content} raw={!isMarkdown} />
          )}
        </div>

        {historyPath && activeSlug && (
          <VersionHistoryModal
            bookSlug={activeSlug}
            filePath={historyPath}
            onClose={() => setHistoryPath(null)}
          />
        )}
      </div>
    );
  }

  // ── Directory browser ─────────────────────────────────────────────────────
  const segments = dirPath ? dirPath.split('/') : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ne-line-soft px-3 py-1.5 text-[11px]">
        <button
          onClick={() => setDirPath('')}
          className={dirPath ? 'text-ne-ink-dim transition-colors hover:text-ne-ink' : 'text-ne-ink'}
        >
          Book
        </button>
        {segments.map((segment, index) => (
          <span key={segments.slice(0, index + 1).join('/')} className="flex items-center gap-1">
            <span className="text-ne-ink-faint">/</span>
            <button
              onClick={() => setDirPath(segments.slice(0, index + 1).join('/'))}
              className={
                index === segments.length - 1
                  ? 'text-ne-ink'
                  : 'text-ne-ink-dim transition-colors hover:text-ne-ink'
              }
            >
              {segment}
            </button>
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <FileBrowser currentPath={dirPath} onNavigate={setDirPath} onFileSelect={handleFileSelect} />
      </div>
    </div>
  );
}
