import path from 'node:path';
import { isSafePathSegment } from '@domain/constants';

/**
 * Absolute path of `relativePath` inside the book `<booksDir>/<slug>`.
 *
 * Throws when the slug isn't a single folder name, or when the joined path
 * leaves the book folder. Joining (not resolving) keeps the long-standing
 * behaviour for in-book paths: a leading `/` still means the book root.
 * Symlinks inside a book are not followed or checked.
 */
export function resolveBookPath(booksDir: string, slug: string, relativePath = ''): string {
  if (!isSafePathSegment(slug)) {
    throw new Error(`Invalid book slug: ${JSON.stringify(slug)}`);
  }
  const bookRoot = path.join(booksDir, slug);
  const fullPath = path.join(bookRoot, relativePath);
  if (fullPath !== bookRoot && !fullPath.startsWith(bookRoot + path.sep)) {
    throw new Error(`Path is outside book "${slug}": ${relativePath}`);
  }
  return fullPath;
}

/** Return `value` if it is a single path segment; throw otherwise. */
export function safeSegment(value: string, what: string): string {
  if (!isSafePathSegment(value)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}
