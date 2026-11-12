import { describe, expect, it } from 'vitest';
import { CHAPTER_NOTES_PATTERN } from '@domain/constants';
import { chapterNotesRule, filterNeverRead, isNeverRead, matchesReadRule } from './readRules';

describe('matchesReadRule', () => {
  it('treats a trailing slash as a directory prefix', () => {
    expect(matchesReadRule('chapters/01-a/draft.md', 'chapters/')).toBe(true);
    expect(matchesReadRule('source/pitch.md', 'chapters/')).toBe(false);
  });

  it('matches exact paths', () => {
    expect(matchesReadRule('source/pitch.md', 'source/pitch.md')).toBe(true);
    expect(matchesReadRule('source/pitch.md.bak', 'source/pitch.md')).toBe(false);
  });

  it('lets * match exactly one path segment', () => {
    expect(matchesReadRule('chapters/01-a/notes.md', CHAPTER_NOTES_PATTERN)).toBe(true);
    expect(matchesReadRule('chapters/01-a/draft.md', CHAPTER_NOTES_PATTERN)).toBe(false);
    expect(matchesReadRule('chapters/notes.md', CHAPTER_NOTES_PATTERN)).toBe(false);
    expect(matchesReadRule('chapters/a/b/notes.md', CHAPTER_NOTES_PATTERN)).toBe(false);
    expect(matchesReadRule('chapters/01-a/notesXmd', CHAPTER_NOTES_PATTERN)).toBe(false); // '.' is literal
  });
});

describe('agent read rules', () => {
  const files = [
    { path: 'chapters/01-a/draft.md' },
    { path: 'chapters/01-a/notes.md' },
    { path: 'source/pitch.md' },
    { path: 'source/reader-report.md' },
  ];

  it('Ghostlight never reads chapter notes or planning docs', () => {
    expect(chapterNotesRule('Ghostlight')).toBe('never');
    expect(isNeverRead('Ghostlight', 'chapters/01-a/notes.md')).toBe(true);
    expect(filterNeverRead(files, 'Ghostlight').map((f) => f.path)).toEqual([
      'chapters/01-a/draft.md',
      'source/reader-report.md',
    ]);
  });

  it('Lumen and Sable read chapter notes', () => {
    expect(chapterNotesRule('Lumen')).toBe('read');
    expect(chapterNotesRule('Sable')).toBe('read');
    expect(filterNeverRead(files, 'Lumen').map((f) => f.path)).toContain('chapters/01-a/notes.md');
  });

  it('non-creative agents have no rules', () => {
    expect(chapterNotesRule('Wrangler')).toBe('unspecified');
    expect(filterNeverRead(files, 'Wrangler')).toEqual(files);
  });
});
