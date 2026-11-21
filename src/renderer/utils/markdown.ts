import { marked } from 'marked';
import DOMPurify from 'dompurify';

// One place for marked's options. Components used to set these themselves;
// marked is a singleton, so the merged result was always this set.
marked.setOptions({ gfm: true, breaks: true, async: false });

/**
 * Sanitize HTML before it goes into `dangerouslySetInnerHTML`. Keeps the
 * HTML elements markdown produces (plus `data-*` attributes, which the
 * line-numbered prose view uses) and drops scripts, event handlers, `<meta>`,
 * `<iframe>`, forms, SVG and MathML.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'style'],
  });
}

/** Render markdown (agent output, book files) to sanitized HTML. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(marked.parse(source ?? '') as string);
}
