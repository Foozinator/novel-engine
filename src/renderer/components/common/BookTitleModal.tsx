import { useEffect, useId, useRef, useState } from 'react';

/**
 * Asks for a book title, and stays open with the reason when it can't be
 * used (#79). Used for New Book and for choosing another title when a pitch
 * or import title is taken.
 */
export function BookTitleModal({
  heading,
  submitLabel,
  initialTitle = '',
  initialError = '',
  onClose,
  onSubmit,
}: {
  heading: string;
  submitLabel: string;
  initialTitle?: string;
  /** Shown until the user edits the title, e.g. the conflict that opened the modal. */
  initialError?: string;
  onClose: () => void;
  /** Resolves to a message to show, or null once the book exists (the caller then closes the modal). */
  onSubmit: (title: string) => Promise<string | null>;
}): React.ReactElement {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const message = await onSubmit(trimmed);
    setBusy(false);
    if (message) {
      setError(message);
      inputRef.current?.select();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div role="dialog" aria-label={heading} className="w-80 rounded-[13px] border border-ne-line bg-ne-bg1 p-5 shadow-xl">
        <h3 className="mb-4 text-sm font-semibold text-ne-ink">{heading}</h3>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError('');
            }}
            placeholder="Book Title"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={`no-drag w-full rounded-md border bg-ne-bg2 px-3 py-2 text-sm text-ne-ink placeholder-ne-ink-faint outline-none focus:border-ne-brass ${
              error ? 'mb-2 border-ne-sable' : 'mb-4 border-ne-line'
            }`}
          />
          {error && (
            <p id={errorId} role="alert" className="mb-4 text-xs text-ne-sable">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="no-drag rounded-md px-3 py-1.5 text-sm text-ne-ink-dim hover:text-ne-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || busy || !!error}
              className="no-drag rounded-md bg-ne-brass px-3 py-1.5 text-sm font-medium text-ne-bg0 hover:bg-ne-brass-hi disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
