import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAppUrlMatcher } from './appUrl';

const INDEX = path.join(path.sep, 'opt', 'novel-engine', 'resources', 'app.asar', '.vite', 'renderer', 'main_window', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;

describe('createAppUrlMatcher — packaged', () => {
  const isAppUrl = createAppUrlMatcher({ indexHtmlPath: INDEX });

  it('accepts the entry page, with or without query and hash', () => {
    expect(isAppUrl(INDEX_URL)).toBe(true);
    expect(isAppUrl(`${INDEX_URL}#/settings`)).toBe(true);
    expect(isAppUrl(`${INDEX_URL}?x=1`)).toBe(true);
  });

  it('refuses other file pages, including ones beside the entry page', () => {
    expect(isAppUrl(pathToFileURL(path.join(path.dirname(INDEX), 'other.html')).href)).toBe(false);
    expect(isAppUrl(pathToFileURL(path.join(path.sep, 'tmp', 'page.html')).href)).toBe(false);
    expect(isAppUrl('file:///')).toBe(false);
  });

  it('refuses web origins, including localhost', () => {
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'http://127.0.0.1/', 'http://localhost.example.com/']) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });

  it.each([
    ['~', '%7E'],
    ['[', '%5B'],
    [']', '%5D'],
    ['^', '%5E'],
    ['|', '%7C'],
  ])('accepts the entry page with %j in its path, escaped or not', (char, escaped) => {
    const file = path.join(path.sep, 'opt', `app${char}1`, 'index.html');
    const matches = createAppUrlMatcher({ indexHtmlPath: file });
    const base = pathToFileURL(file).href.replace(/app.*1/, 'app@1');
    expect(matches(base.replace('@', char))).toBe(true);
    expect(matches(base.replace('@', escaped))).toBe(true);
    expect(matches(base.replace('@', '_'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('ignores the case of the drive letter only', () => {
    const matches = createAppUrlMatcher({ indexHtmlPath: 'C:\\App\\index.html' });
    expect(matches('file:///c:/App/index.html')).toBe(true);
    expect(matches('file:///C:/App/index.html')).toBe(true);
    expect(matches('file:///D:/App/index.html')).toBe(false);
    expect(matches('file:///C:/App/other.html')).toBe(false);
  });

  it('refuses garbage', () => {
    expect(isAppUrl('')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
  });
});

describe('createAppUrlMatcher — dev server', () => {
  const isAppUrl = createAppUrlMatcher({ devServerUrl: 'http://localhost:5173', indexHtmlPath: INDEX });

  it('accepts any page on the dev server origin', () => {
    expect(isAppUrl('http://localhost:5173/')).toBe(true);
    expect(isAppUrl('http://localhost:5173/src/renderer/main.tsx')).toBe(true);
  });

  it('refuses other ports, look-alike hosts and file pages', () => {
    for (const url of ['http://localhost:5174/', 'http://localhost.example.com:5173/', 'http://127.0.0.1:5173/', INDEX_URL]) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });
});
