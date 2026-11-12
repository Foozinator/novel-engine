import { readFile } from 'node:fs/promises';

/**
 * Read the app-level author profile for inlining into a system prompt.
 *
 * The profile lives in the userData root, outside the book directory the CLI
 * runs in, so agents can't reliably reach it with Bash. Returns '' when the
 * file is missing or unreadable — ContextBuilder then drops it from the read
 * guidance instead of pointing at a file that isn't there.
 */
export async function readAuthorProfile(profilePath: string): Promise<string> {
  try {
    return await readFile(profilePath, 'utf-8');
  } catch {
    return '';
  }
}
