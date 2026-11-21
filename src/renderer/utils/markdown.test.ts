import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml } from './markdown';

describe('renderMarkdown', () => {
  it('renders ordinary markdown', () => {
    const html = renderMarkdown('# Title\n\nSome *em* text and a [link](https://example.com).');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it('keeps line breaks inside a paragraph (breaks: true)', () => {
    expect(renderMarkdown('one\ntwo')).toContain('one<br>two');
  });

  it.each([
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://example.com/">', /<meta/i],
    ['script', '<script>alert(1)</script>', /<script/i],
    ['event handler', '<img src="x" onerror="alert(1)">', /onerror/i],
    ['iframe', '<iframe src="https://example.com"></iframe>', /<iframe/i],
    ['form', '<form action="https://example.com"><button>go</button></form>', /<form|<button/i],
    ['javascript: link', '[x](javascript:alert(1))', /javascript:/i],
    ['svg', '<svg><script>alert(1)</script></svg>', /<svg|<script/i],
    ['base', '<base href="https://example.com/">', /<base/i],
  ])('strips %s', (_name, source, forbidden) => {
    expect(renderMarkdown(`Text.\n\n${source}\n\nMore.`)).not.toMatch(forbidden);
  });
});

describe('sanitizeHtml', () => {
  it('keeps data-* attributes used by the line-numbered prose view', () => {
    expect(sanitizeHtml('<p data-line="12">Hi</p>')).toBe('<p data-line="12">Hi</p>');
  });
});
