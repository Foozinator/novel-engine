import { describeBookTitleConflict } from '@domain/constants';

/**
 * Why `title` can't be used for a new book, or null when it is free (#79).
 * A failed lookup returns null: `createBook` refuses a taken title anyway,
 * and the caller then shows that error instead.
 */
export async function findTitleConflictMessage(title: string): Promise<string | null> {
  try {
    const conflict = await window.novelEngine.books.findTitleConflict(title);
    return conflict ? describeBookTitleConflict(title, conflict) : null;
  } catch (err) {
    console.error('Failed to check the book title:', err);
    return null;
  }
}

/** Outcome of turning a pitch into a book. */
export type PitchToBookResult =
  | { ok: true; slug: string }
  | {
      ok: false;
      message: string;
      /** Set when the title is taken (#79): the title to offer for editing. */
      takenTitle?: string;
    };

/** The message of an IPC rejection, without Electron's "Error invoking remote method" prefix. */
export function ipcErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback;
}
