import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { launchApp, type LaunchedApp } from './launch';

/**
 * Smoke test: the packaged app starts, renders, creates a book, stores a chapter
 * (filesystem + SQLite version history) and shows that chapter in the UI.
 *
 * It never calls a model: the Claude/Codex/Ollama commands are stubbed (see launch.ts).
 */

const BOOK_TITLE = 'E2E Smoke Book';
const CHAPTER_PATH = 'chapters/01-smoke-test/draft.md';
const CHAPTER_TEXT = 'The smoke test walked into the manuscript and found it intact.';

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.cleanup();
});

test('packaged app starts, creates a book and shows a chapter', async () => {
  const { app, page, userDataDir } = launched;

  await test.step('runs against the temporary data folder', async () => {
    const actual = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(path.resolve(actual)).toBe(path.resolve(userDataDir));
    // The SQLite database opened (native module loaded) in the temp folder.
    await expect.poll(() => existsSync(path.join(userDataDir, 'novel-engine.db'))).toBe(true);
  });

  await test.step('main window renders the library', async () => {
    await expect(page).toHaveTitle('Novel Engine');
    await expect(page.getByRole('button', { name: /New Book/ })).toBeVisible();
  });

  await test.step('creates a throwaway book through the UI', async () => {
    await page.getByRole('button', { name: /New Book/ }).click();
    await page.getByPlaceholder('Book Title').fill(BOOK_TITLE);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(BOOK_TITLE).first()).toBeVisible();
  });

  const slug = await test.step('writes a chapter through the preload bridge', async () => {
    return page.evaluate(
      async ({ title, chapterPath, text }) => {
        const books = await window.novelEngine.books.list();
        const book = books.find((b) => b.title === title);
        if (!book) throw new Error(`book "${title}" not found`);
        await window.novelEngine.files.write(book.slug, chapterPath, `# Chapter 1\n\n${text}\n`);
        await window.novelEngine.versions.snapshot(book.slug, chapterPath, 'user');
        return book.slug;
      },
      { title: BOOK_TITLE, chapterPath: CHAPTER_PATH, text: CHAPTER_TEXT },
    );
  });

  await test.step('reads the chapter back and finds its version history', async () => {
    const result = await page.evaluate(
      async ({ bookSlug, chapterPath }) => ({
        content: await window.novelEngine.files.read(bookSlug, chapterPath),
        versions: await window.novelEngine.versions.getCount(bookSlug, chapterPath),
      }),
      { bookSlug: slug, chapterPath: CHAPTER_PATH },
    );
    expect(result.content).toContain(CHAPTER_TEXT);
    expect(result.versions).toBeGreaterThan(0);
  });

  await test.step('opens the chapter in the UI', async () => {
    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    const chapterSelect = page.locator('select[title="Select chapter"]');
    await expect(chapterSelect).toBeVisible();
    await chapterSelect.selectOption('01-smoke-test');
    await expect(page.getByText(CHAPTER_TEXT)).toBeVisible();
  });
});
