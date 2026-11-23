import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShelvedPitch, ShelvedPitchMeta } from '@domain/types';
import { usePitchShelfStore } from './pitchShelfStore';
import { installNovelEngineMock, makeBookMeta, type NovelEngineMock } from '../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../test/resetStores';

resetStoresBeforeEach(usePitchShelfStore);

function makePitchMeta(overrides: Partial<ShelvedPitchMeta> = {}): ShelvedPitchMeta {
  return {
    slug: 'storm-pitch',
    title: 'Storm Pitch',
    logline: 'A lighthouse keeper vs the sea.',
    shelvedAt: '2026-01-01T00:00:00.000Z',
    shelvedFrom: 'old-book',
    ...overrides,
  };
}

const fullPitch: ShelvedPitch = { ...makePitchMeta(), content: '# Storm Pitch\n\nLogline…' };

let mock: NovelEngineMock;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mock = installNovelEngineMock();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('pitchShelfStore', () => {
  it('loadPitches populates the shelf; failure stores the error message', async () => {
    mock.pitches.list.mockResolvedValue([makePitchMeta()]);
    await usePitchShelfStore.getState().loadPitches();
    expect(usePitchShelfStore.getState().pitches).toHaveLength(1);
    expect(usePitchShelfStore.getState().loading).toBe(false);

    mock.pitches.list.mockRejectedValue(new Error('shelf unreadable'));
    await usePitchShelfStore.getState().loadPitches();
    expect(usePitchShelfStore.getState().error).toBe('shelf unreadable');
    expect(usePitchShelfStore.getState().loading).toBe(false);
  });

  it('previewPitchBySlug loads the full pitch; closePreview clears it', async () => {
    mock.pitches.read.mockResolvedValue(fullPitch);

    await usePitchShelfStore.getState().previewPitchBySlug('storm-pitch');
    expect(usePitchShelfStore.getState().previewPitch?.content).toContain('Logline');
    expect(usePitchShelfStore.getState().previewLoading).toBe(false);

    usePitchShelfStore.getState().closePreview();
    expect(usePitchShelfStore.getState().previewPitch).toBeNull();
  });

  it('preview failure clears the loading flag and keeps no preview', async () => {
    mock.pitches.read.mockRejectedValue(new Error('missing file'));

    await usePitchShelfStore.getState().previewPitchBySlug('ghost');

    expect(usePitchShelfStore.getState().previewLoading).toBe(false);
    expect(usePitchShelfStore.getState().previewPitch).toBeNull();
  });

  it('restorePitch promotes to a book, removes the pitch locally, and returns the new slug', async () => {
    usePitchShelfStore.setState({ pitches: [makePitchMeta()], previewPitch: fullPitch });
    mock.pitches.restore.mockResolvedValue(makeBookMeta({ slug: 'storm-book' }));

    const result = await usePitchShelfStore.getState().restorePitch('storm-pitch');

    expect(result).toEqual({ ok: true, slug: 'storm-book' });
    expect(mock.books.findTitleConflict).toHaveBeenCalledWith('Storm Pitch');
    expect(mock.pitches.restore).toHaveBeenCalledWith('storm-pitch');
    expect(usePitchShelfStore.getState().pitches).toEqual([]);
    expect(usePitchShelfStore.getState().previewPitch).toBeNull();
  });

  it('restorePitch reports a taken title without restoring, then restores under a new title (#79)', async () => {
    usePitchShelfStore.setState({ pitches: [makePitchMeta()] });
    mock.books.findTitleConflict.mockImplementation(async (title: string) =>
      title === 'Storm Pitch' ? { slug: 'storm-pitch', title: 'Storm Pitch', archived: true } : null,
    );

    expect(await usePitchShelfStore.getState().restorePitch('storm-pitch')).toEqual({
      ok: false,
      message: 'An archived book titled "Storm Pitch" already exists. Choose another title.',
      takenTitle: 'Storm Pitch',
    });
    expect(mock.pitches.restore).not.toHaveBeenCalled();
    expect(usePitchShelfStore.getState().pitches).toHaveLength(1);

    mock.pitches.restore.mockResolvedValue(makeBookMeta({ slug: 'storm-returns' }));
    expect(await usePitchShelfStore.getState().restorePitch('storm-pitch', ' Storm Returns ')).toEqual({
      ok: true,
      slug: 'storm-returns',
    });
    expect(mock.pitches.restore).toHaveBeenCalledWith('storm-pitch', 'Storm Returns');
  });

  it('restorePitch reads the pitch title when the shelf is not loaded, and reports failures', async () => {
    mock.pitches.read.mockResolvedValue(fullPitch);
    mock.pitches.restore.mockRejectedValue(
      new Error("Error invoking remote method 'pitches:restore': Error: disk full"),
    );

    expect(await usePitchShelfStore.getState().restorePitch('storm-pitch')).toEqual({ ok: false, message: 'disk full' });
    expect(mock.books.findTitleConflict).toHaveBeenCalledWith('Storm Pitch');
  });

  it('deletePitch removes the pitch from the shelf', async () => {
    usePitchShelfStore.setState({ pitches: [makePitchMeta(), makePitchMeta({ slug: 'other' })] });

    await usePitchShelfStore.getState().deletePitch('storm-pitch');

    expect(mock.pitches.delete).toHaveBeenCalledWith('storm-pitch');
    expect(usePitchShelfStore.getState().pitches.map((p) => p.slug)).toEqual(['other']);
  });

  it('shelveCurrentPitch prepends the newly shelved pitch', async () => {
    usePitchShelfStore.setState({ pitches: [makePitchMeta({ slug: 'old' })] });
    mock.pitches.shelve.mockResolvedValue(makePitchMeta({ slug: 'fresh' }));

    await usePitchShelfStore.getState().shelveCurrentPitch('book-a', 'a logline');

    expect(mock.pitches.shelve).toHaveBeenCalledWith('book-a', 'a logline');
    expect(usePitchShelfStore.getState().pitches.map((p) => p.slug)).toEqual(['fresh', 'old']);
  });
});
