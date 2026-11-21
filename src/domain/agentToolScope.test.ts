import { describe, expect, it } from 'vitest';
import {
  buildClaudeCliAllowedTools,
  DEFAULT_SETTINGS,
  isSafePathSegment,
  toClaudeCliRulePath,
} from './constants';

describe('toClaudeCliRulePath', () => {
  it('marks POSIX absolute paths with a double slash', () => {
    expect(toClaudeCliRulePath('/home/u/.config/Novel Engine Spur/books/**'))
      .toBe('//home/u/.config/Novel Engine Spur/books/**');
  });

  it('converts Windows drive paths to the CLI POSIX form', () => {
    expect(toClaudeCliRulePath('C:\\Users\\u\\AppData\\Roaming\\Novel Engine Spur\\books/**'))
      .toBe('//c/Users/u/AppData/Roaming/Novel Engine Spur/books/**');
  });
});

describe('buildClaudeCliAllowedTools', () => {
  const scopes = ['/data/books/**', '/data/author-profile.md'];

  it('scopes Read, Write and Edit to each path and never grants them bare', () => {
    const tools = buildClaudeCliAllowedTools({ scopes, webFetch: true }).split(',');
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(tools).toContain(`${tool}(//data/books/**)`);
      expect(tools).toContain(`${tool}(//data/author-profile.md)`);
      expect(tools).not.toContain(tool);
    }
  });

  it('includes WebFetch only when enabled; WebSearch either way', () => {
    expect(buildClaudeCliAllowedTools({ scopes, webFetch: true }).split(',')).toContain('WebFetch');
    const off = buildClaudeCliAllowedTools({ scopes, webFetch: false }).split(',');
    expect(off).not.toContain('WebFetch');
    expect(off).toContain('WebSearch');
  });

  it('keeps Bash limited to the command allowlist', () => {
    const tools = buildClaudeCliAllowedTools({ scopes, webFetch: true }).split(',');
    expect(tools.filter((t) => t.startsWith('Bash'))).toContain('Bash(wc:*)');
    expect(tools).not.toContain('Bash');
  });
});

describe('isSafePathSegment', () => {
  it.each(['my-book', 'My Book', '__pitch-room__', '..notes'])('accepts %j', (value) => {
    expect(isSafePathSegment(value)).toBe(true);
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', '/etc', 'C:x', 'a\0b', undefined, 42])('rejects %j', (value) => {
    expect(isSafePathSegment(value)).toBe(false);
  });
});

describe('DEFAULT_SETTINGS.allowWebFetch', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.allowWebFetch).toBe(true);
  });
});
