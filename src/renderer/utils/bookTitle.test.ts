import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTitleConflictMessage, ipcErrorMessage } from './bookTitle';
import { installNovelEngineMock, type NovelEngineMock } from '../../test/novelEngineMock';

let mock: NovelEngineMock;

beforeEach(() => {
  mock = installNovelEngineMock();
});

describe('findTitleConflictMessage', () => {
  it('returns null for a free title and the shared message for a taken one', async () => {
    expect(await findTitleConflictMessage('Free')).toBeNull();

    mock.books.findTitleConflict.mockResolvedValue({ slug: 'twin', title: 'Twin', archived: true });
    expect(await findTitleConflictMessage('Twin')).toBe(
      'An archived book titled "Twin" already exists. Choose another title.',
    );
  });

  it('returns null when the lookup fails, leaving the refusal to createBook', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mock.books.findTitleConflict.mockRejectedValue(new Error('ipc down'));

    expect(await findTitleConflictMessage('Twin')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('ipcErrorMessage', () => {
  it('strips the Electron prefix and falls back for empty messages', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'books:create': Error: taken"))).toBe('taken');
    expect(ipcErrorMessage(new Error('plain'))).toBe('plain');
    expect(ipcErrorMessage('a string')).toBe('a string');
    expect(ipcErrorMessage(new Error(''), 'Fallback')).toBe('Fallback');
    expect(ipcErrorMessage(undefined)).toBe('Something went wrong');
  });
});
