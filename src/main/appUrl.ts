import { pathToFileURL } from 'node:url';

/**
 * Build a predicate that is true only for the app's own entry page.
 *
 * - Dev (Vite server): same origin as the dev server URL.
 * - Packaged: the exact `index.html` file URL. Query and hash are ignored;
 *   any other `file://` URL is rejected.
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

  const indexPathname = pathToFileURL(entry.indexHtmlPath).pathname;
  return (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' && parsed.pathname === indexPathname;
    } catch {
      return false;
    }
  };
}
