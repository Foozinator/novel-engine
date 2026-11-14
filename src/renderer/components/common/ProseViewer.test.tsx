import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { marked } from 'marked';
import { DEFAULT_SETTINGS } from '@domain/constants';
import { ProseViewer, renderWithLineNumbers, useBookFile } from './ProseViewer';
import { useFileChangeStore } from '../../stores/fileChangeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { installNovelEngineMock, type NovelEngineMock } from '../../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../../test/resetStores';

resetStoresBeforeEach(useFileChangeStore, useSettingsStore);

describe('ProseViewer', () => {
  it('renders markdown as typeset HTML', () => {
    render(<ProseViewer content={'# The Title\n\nSome *emphasis* here.'} />);
    expect(screen.getByRole('heading', { level: 1, name: 'The Title' })).toBeInTheDocument();
    expect(screen.getByText('emphasis')).toBeInTheDocument();
  });

  it('renders raw mode as monospace preformatted text, unparsed', () => {
    const { container } = render(<ProseViewer content={'# not a heading'} raw />);
    const pre = container.querySelector('pre');
    expect(pre).toHaveTextContent('# not a heading');
    expect(container.querySelector('h1')).toBeNull();
  });

  it('widens the measure with the wide prop', () => {
    const { container } = render(<ProseViewer content="text" wide />);
    expect(container.firstElementChild?.className).toContain('max-w-[68ch]');
  });

  it('uses the default font size before settings load', () => {
    const { container } = render(<ProseViewer content="text" />);
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe('16.5px');
  });

  it('takes its font size from the proseFontSize setting', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, proseFontSize: 22 } });
    const { container } = render(<ProseViewer content="text" />);
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe('22px');
  });

  it('adds no line numbers unless asked', () => {
    const { container } = render(<ProseViewer content={'One\n\nTwo'} />);
    expect(container.querySelector('[data-line]')).toBeNull();
  });

  it('numbers top-level blocks with their source line when lineNumbers is set', () => {
    const { container } = render(<ProseViewer content={'# Title\n\nOne\n\nTwo'} lineNumbers />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('ne-prose-lines');
    const lines = [...root.querySelectorAll('[data-line]')].map((el) => [el.tagName, el.getAttribute('data-line')]);
    expect(lines).toEqual([['H1', '1'], ['P', '3'], ['P', '5']]);
  });
});

describe('renderWithLineNumbers', () => {
  const lineOf = (html: string): string[] =>
    [...html.matchAll(/<(\w+) data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

  it('matches plain marked output apart from the data-line attributes', () => {
    const src = '# T\n\nA *b* c.\n\n> q\n\n- x\n- y\n\n---\n\nEnd.';
    const numbered = renderWithLineNumbers(src).replace(/ data-line="\d+"/g, '');
    expect(numbered).toBe(marked.parse(src));
  });

  it('gives a hard-wrapped paragraph its first line and counts extra blank lines', () => {
    expect(lineOf(renderWithLineNumbers('First\nwrapped.\n\n\n\nSecond'))).toEqual(['p:1', 'p:6']);
  });

  it('stays aligned past link reference definitions, which marked drops', () => {
    const src = 'See [x][r].\n\n[r]: http://example.com\n\nAfter.';
    const html = renderWithLineNumbers(src);
    expect(lineOf(html)).toEqual(['p:1', 'p:5']);
    expect(html).toContain('href="http://example.com"');
  });

  it('normalises CRLF line endings', () => {
    expect(lineOf(renderWithLineNumbers('One\r\n\r\nTwo\r\n\r\n* a'))).toEqual(['p:1', 'p:3', 'ul:5']);
  });

  it('skips a leading blank run', () => {
    expect(lineOf(renderWithLineNumbers('\n\n\nText'))).toEqual(['p:4']);
  });
});

describe('useBookFile', () => {
  let mock: NovelEngineMock;

  beforeEach(() => {
    mock = installNovelEngineMock();
  });

  it('reads the file and exposes its content', async () => {
    mock.files.read.mockResolvedValue('CONTENT');
    const { result } = renderHook(() => useBookFile('book', 'source/pitch.md'));

    await waitFor(() => expect(result.current.content).toBe('CONTENT'));
    expect(result.current).toEqual({ content: 'CONTENT', loading: false, error: null });
    expect(mock.files.read).toHaveBeenCalledWith('book', 'source/pitch.md');
  });

  it('resets to empty without reading when path is null', () => {
    const { result } = renderHook(() => useBookFile('book', null));
    expect(result.current).toEqual({ content: '', loading: false, error: null });
    expect(mock.files.read).not.toHaveBeenCalled();
  });

  it('surfaces read failures as an error message', async () => {
    mock.files.read.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useBookFile('book', 'source/pitch.md'));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.content).toBe('');
    expect(result.current.loading).toBe(false);
  });

  it('re-reads on file-change revision bump, keeping stale content on screen', async () => {
    mock.files.read.mockResolvedValue('V1');
    const { result } = renderHook(() => useBookFile('book', 'source/pitch.md'));
    await waitFor(() => expect(result.current.content).toBe('V1'));

    mock.files.read.mockResolvedValue('V2');
    act(() => useFileChangeStore.getState().notifyChange());

    // Same file refreshing → previous content stays visible (no flash)
    expect(result.current.content).toBe('V1');
    await waitFor(() => expect(result.current.content).toBe('V2'));
    expect(mock.files.read).toHaveBeenCalledTimes(2);
  });

  it('clears immediately when switching to a different file', async () => {
    mock.files.read.mockResolvedValue('FIRST');
    const { result, rerender } = renderHook(({ path }) => useBookFile('book', path), {
      initialProps: { path: 'source/pitch.md' },
    });
    await waitFor(() => expect(result.current.content).toBe('FIRST'));

    let resolveRead!: (content: string) => void;
    mock.files.read.mockImplementation(
      () => new Promise<string>((resolve) => { resolveRead = resolve; }),
    );
    rerender({ path: 'source/other.md' });

    // Different file → stale prose never shows
    expect(result.current).toEqual({ content: '', loading: true, error: null });
    resolveRead('SECOND');
    await waitFor(() => expect(result.current.content).toBe('SECOND'));
  });
});
