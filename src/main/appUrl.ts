import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The local path a file URL names, in one spelling. Throws for a URL that
 * doesn't name a local path on this platform. Only the drive letter's case is
 * normalized; the rest of the path must match exactly.
 */
function filePathOf(url: URL): string {
  return fileURLToPath(url).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/**
 * Build a predicate that is true only for the app's own entry page.
 *
 * - Dev (Vite server): same origin as the dev server URL.
 * - Packaged: the exact `index.html` file. URLs are compared as file paths,
 *   because `loadFile` and `pathToFileURL` escape some characters differently
 *   (`~ [ ] ^ |`, varying by Node version). Query and hash are ignored; any
 *   other `file://` URL is rejected.
 *
 * Used for the main window's navigation guard and the IPC sender check.
 */
export function createAppUrlMatcher(entry: {
  devServerUrl?: string;
  indexHtmlPath: string;
}): (url: string) => boolean {
  if (entry.devServerUrl) {
    const devOrigin = new URL(entry.devServerUrl).origin;
    return (url) => {
      try {
        return new URL(url).origin === devOrigin;
      } catch {
        return false;
      }
    };
  }

  const indexPath = filePathOf(pathToFileURL(entry.indexHtmlPath));
  return (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' && filePathOf(parsed) === indexPath;
    } catch {
      return false;
    }
  };
}
