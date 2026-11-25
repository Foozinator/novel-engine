import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #72: only `src/main/electron/` and `src/preload/` may import `electron`.
 * Everything else (composition root, handlers, services) must run without it,
 * so a headless server can reuse it.
 */

const SRC = path.resolve(__dirname, '..');
const ALLOWED = [path.join(SRC, 'main', 'electron') + path.sep, path.join(SRC, 'preload') + path.sep];
// Matches `from 'electron'`, `import 'electron'`, `require('electron')`, `import('electron')`, `vi.mock('electron'`
const ELECTRON_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]electron['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('electron isolation', () => {
  it('no file outside src/main/electron and src/preload imports electron', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.some((dir) => file.startsWith(dir)))
      // The electron mock and this test only mention the module in comments and patterns.
      .filter((file) => !file.startsWith(path.join(SRC, 'test', 'mocks') + path.sep) && file !== __filename)
      .filter((file) => ELECTRON_IMPORT.test(readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
