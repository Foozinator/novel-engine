import { useEffect, useRef, useState } from 'react';
import { marked, type Token, type TokensList } from 'marked';
import { PROSE_FONT_SIZE_DEFAULT } from '@domain/constants';
import { useFileChangeStore } from '../../stores/fileChangeStore';
import { useSettingsStore } from '../../stores/settingsStore';

marked.setOptions({ async: false });

/**
 * Literary typeset styling per the streamlined-workspace mock. The base size
 * comes from settings (`proseFontSize`, set inline); heading and code sizes
 * are em-relative so they scale with it (16.5px base → 26 / 19 / 13px).
 */
const PROSE_CLASS = [
  'mx-auto font-ne-serif leading-[1.78] text-ne-ink',
  '[&_p]:mb-4 [&_p]:indent-[1.4em] [&_p:first-of-type]:indent-0',
  '[&_h1]:mb-5 [&_h1]:text-[1.576em] [&_h1]:font-medium [&_h1]:leading-snug',
  '[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:font-ne-ui [&_h2]:text-[0.788em] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.1em] [&_h2]:text-ne-ink-dim',
  '[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-[1.152em] [&_h3]:font-medium',
  '[&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1',
  '[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-ne-brass/40 [&_blockquote]:pl-4 [&_blockquote]:text-ne-ink-dim',
  '[&_hr]:my-9 [&_hr]:border-ne-line',
  '[&_a]:text-ne-quill [&_a]:underline',
  '[&_code]:font-ne-mono [&_code]:text-[0.788em] [&_code]:text-ne-ink-dim',
  '[&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-ne-bg2 [&_pre]:p-3',
  '[&_table]:mb-4 [&_table]:w-full [&_table]:font-ne-ui [&_table]:text-[0.788em]',
  '[&_th]:border-b [&_th]:border-ne-line [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_td]:border-b [&_td]:border-ne-line-soft [&_td]:px-2 [&_td]:py-1',
].join(' ');

/** Raw (monospace) text runs smaller than prose: 12.5px at the 16.5px default. */
const RAW_SIZE_RATIO = 12.5 / 16.5;

/**
 * Render markdown with each top-level block's opening tag tagged
 * `data-line="N"`, N being the 1-based line in `content` where the block
 * starts. Sibling structure is unchanged, so `:first-of-type` rules still
 * apply. Blocks whose HTML does not start with an element (comments) and
 * blocks marked cannot locate in the source get no number.
 */
export function renderWithLineNumbers(content: string): string {
  const source = content.replace(/\r\n?/g, '\n');
  const tokens = marked.lexer(source);
  let cursor = 0;
  let line = 1;
  let html = '';

  for (const token of tokens) {
    const single = Object.assign([token], { links: tokens.links }) as Token[] as TokensList;
    const blockHtml = marked.parser(single);
    if (token.type === 'space' || !token.raw) {
      html += blockHtml;
      continue;
    }
    // Locate the block in the source: link definitions are dropped from the
    // token list, so summing raw lengths cannot track the position.
    const index = source.indexOf(token.raw, cursor);
    if (index === -1) {
      html += blockHtml;
      continue;
    }
    line += countNewlines(source, cursor, index);
    const lead = /^\n*/.exec(token.raw)?.[0].length ?? 0;
    const startLine = line + lead;
    line += countNewlines(source, index, index + token.raw.length);
    cursor = index + token.raw.length;
    html += blockHtml.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-line="${startLine}"`);
  }
  return html;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

type ProseViewerProps = {
  content: string;
  /** Render as raw monospace text (JSON, non-markdown files). */
  raw?: boolean;
  /** 68ch measure (manuscript view) instead of the companion's 62ch. */
  wide?: boolean;
  /** Show source line numbers in a left gutter (chapter drafts). */
  lineNumbers?: boolean;
};

/**
 * Shared typeset markdown renderer for the workspace (companion tabs,
 * manuscript view). Callers own the scroll container. Font size follows
 * the `proseFontSize` setting (adjusted by useProseZoom).
 */
export function ProseViewer({
  content,
  raw = false,
  wide = false,
  lineNumbers = false,
}: ProseViewerProps): React.ReactElement {
  const fontSize = useSettingsStore((s) => s.settings?.proseFontSize ?? PROSE_FONT_SIZE_DEFAULT);

  if (raw) {
    return (
      <pre
        className="mx-auto max-w-[72ch] whitespace-pre-wrap font-ne-mono leading-relaxed text-ne-ink-dim"
        style={{ fontSize: `${fontSize * RAW_SIZE_RATIO}px` }}
      >
        {content}
      </pre>
    );
  }
  const html = lineNumbers ? renderWithLineNumbers(content) : (marked.parse(content) as string);
  const measure = lineNumbers
    ? `ne-prose-lines pl-[3.2em] ${wide ? 'max-w-[calc(68ch+3.2em)]' : 'max-w-[calc(62ch+3.2em)]'}`
    : wide
      ? 'max-w-[68ch]'
      : 'max-w-[62ch]';
  const style = { fontSize: `${fontSize}px`, '--ne-prose-size': `${fontSize}px` } as React.CSSProperties;
  return (
    <div
      className={`${PROSE_CLASS} ${measure}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type BookFileState = {
  content: string;
  loading: boolean;
  error: string | null;
};

/**
 * Read a book file and keep it live: re-reads whenever the file-change
 * revision bumps (agent writes), keeping the previous content on screen
 * while the refresh is in flight so streaming edits land without a flash.
 */
export function useBookFile(bookSlug: string, path: string | null): BookFileState {
  const revision = useFileChangeStore((s) => s.revision);
  const [state, setState] = useState<BookFileState>({ content: '', loading: false, error: null });
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bookSlug || !path) {
      loadedKeyRef.current = null;
      setState({ content: '', loading: false, error: null });
      return;
    }

    let cancelled = false;
    const key = `${bookSlug}:${path}`;
    // Same file refreshing (revision bump) → keep content on screen.
    // Different file → clear immediately so stale prose never shows.
    setState((prev) =>
      loadedKeyRef.current === key
        ? { ...prev, loading: prev.content === '', error: null }
        : { content: '', loading: true, error: null },
    );
    loadedKeyRef.current = key;

    window.novelEngine.files
      .read(bookSlug, path)
      .then((content) => {
        if (!cancelled) setState({ content, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            content: '',
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to read file',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bookSlug, path, revision]);

  return state;
}
