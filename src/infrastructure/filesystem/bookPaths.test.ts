import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBookPath, safeSegment, toPortablePath } from './bookPaths';

const BOOKS = path.join(path.sep, 'data', 'books');

describe('resolveBookPath', () => {
  it('joins in-book paths under the book folder', () => {
    expect(resolveBookPath(BOOKS, 'my-book', 'chapters/01/draft.md'))
      .toBe(path.join(BOOKS, 'my-book', 'chapters', '01', 'draft.md'));
    expect(resolveBookPath(BOOKS, 'my-book')).toBe(path.join(BOOKS, 'my-book'));
    expect(resolveBookPath(BOOKS, 'my-book', 'chapters/../about.json'))
      .toBe(path.join(BOOKS, 'my-book', 'about.json'));
  });

  it('keeps a leading slash inside the book, as path.join always did', () => {
    expect(resolveBookPath(BOOKS, 'my-book', '/about.json')).toBe(path.join(BOOKS, 'my-book', 'about.json'));
  });

  it('accepts names that merely start with two dots', () => {
    expect(resolveBookPath(BOOKS, 'my-book', '..notes.md')).toBe(path.join(BOOKS, 'my-book', '..notes.md'));
  });

  it.each(['../other-book/about.json', '../../etc/hosts', 'chapters/../../x'])('refuses %j', (rel) => {
    expect(() => resolveBookPath(BOOKS, 'my-book', rel)).toThrow(/outside book/);
  });

  it.each(['..', '.', '', '../..', '/etc', 'a/b', 'a\\b'])('refuses slug %j', (slug) => {
    expect(() => resolveBookPath(BOOKS, slug, 'x.md')).toThrow(/Invalid book slug/);
  });

  it('refuses a sibling folder that shares the book name as a prefix', () => {
    expect(() => resolveBookPath(BOOKS, 'my-book', '../my-book-2/x.md')).toThrow(/outside book/);
  });
});

describe('toPortablePath', () => {
  it('turns Windows separators into /', () => {
    expect(toPortablePath('chapters\\01-one\\draft.md', '\\')).toBe('chapters/01-one/draft.md');
    expect(toPortablePath('about.json', '\\')).toBe('about.json');
  });

  it('leaves a POSIX path as it is, including a \\ inside a name', () => {
    expect(toPortablePath('chapters/01-one/draft.md', '/')).toBe('chapters/01-one/draft.md');
    expect(toPortablePath('notes/odd\\name.md', '/')).toBe('notes/odd\\name.md');
  });

  it('uses the platform separator by default', () => {
    expect(toPortablePath(path.join('chapters', '01-one', 'draft.md'))).toBe('chapters/01-one/draft.md');
  });
});

describe('safeSegment', () => {
  it('returns a single segment and throws otherwise', () => {
    expect(safeSegment('conv-1', 'draft ID')).toBe('conv-1');
    expect(() => safeSegment('../x', 'draft ID')).toThrow(/Invalid draft ID/);
  });
});
