import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImportPreview, SeriesImportPreview, SeriesImportResult, SeriesImportVolume } from '@domain/types';
import { useSeriesImportStore } from './seriesImportStore';
import { installNovelEngineMock, makeAppSettings, type NovelEngineMock } from '../../test/novelEngineMock';
import { resetStoresBeforeEach } from '../../test/resetStores';

resetStoresBeforeEach(useSeriesImportStore);

function makeImportPreview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    sourceFile: '/tmp/vol.md',
    sourceFormat: 'markdown',
    markdownContent: '# Vol',
    chapters: [
      { index: 0, title: 'One', startLine: 0, endLine: 9, wordCount: 100, content: 'c' },
    ],
    totalWordCount: 100,
    detectedTitle: 'Volume Title',
    detectedAuthor: '',
    ambiguous: false,
    ...overrides,
  };
}

function makeVolume(index: number, overrides: Partial<SeriesImportVolume> = {}): SeriesImportVolume {
  return {
    index,
    preview: makeImportPreview({ detectedTitle: `Book ${index + 1}` }),
    volumeNumber: index + 1,
    skipped: false,
    ...overrides,
  };
}

function makeSeriesPreview(overrides: Partial<SeriesImportPreview> = {}): SeriesImportPreview {
  return {
    seriesName: 'The Storm Cycle',
    volumes: [makeVolume(0), makeVolume(1), makeVolume(2)],
    totalWordCount: 300,
    totalChapterCount: 3,
    ...overrides,
  };
}

const seriesResult: SeriesImportResult = {
  seriesSlug: 'the-storm-cycle',
  seriesName: 'The Storm Cycle',
  volumeResults: [],
  totalBooks: 3,
  totalChapters: 3,
  totalWordCount: 300,
};

let mock: NovelEngineMock;

beforeEach(() => {
  mock = installNovelEngineMock();
});

async function toPreviewStep(preview = makeSeriesPreview()): Promise<void> {
  mock.seriesImport.selectFiles.mockResolvedValue(['/tmp/v1.md', '/tmp/v2.md', '/tmp/v3.md']);
  mock.seriesImport.preview.mockResolvedValue(preview);
  await useSeriesImportStore.getState().startImport();
}

describe('seriesImportStore', () => {
  describe('startImport', () => {
    it('stays idle when the picker is cancelled or returns no files', async () => {
      mock.seriesImport.selectFiles.mockResolvedValue(null);
      await useSeriesImportStore.getState().startImport();
      expect(useSeriesImportStore.getState().step).toBe('idle');

      mock.seriesImport.selectFiles.mockResolvedValue([]);
      await useSeriesImportStore.getState().startImport();
      expect(useSeriesImportStore.getState().step).toBe('idle');
      expect(mock.seriesImport.preview).not.toHaveBeenCalled();
    });

    it('reaches the preview step with the first detected author, falling back to settings', async () => {
      const preview = makeSeriesPreview();
      preview.volumes[1] = makeVolume(1, {
        preview: makeImportPreview({ detectedAuthor: 'Vol Two Author' }),
      });
      await toPreviewStep(preview);

      const state = useSeriesImportStore.getState();
      expect(state.step).toBe('preview');
      expect(state.seriesName).toBe('The Storm Cycle');
      expect(state.author).toBe('Vol Two Author');
      expect(state.volumes).toHaveLength(3);

      // No detected author anywhere → settings author name
      useSeriesImportStore.getState().reset();
      mock.settings.load.mockResolvedValue(makeAppSettings({ authorName: 'Settings Author' }));
      await toPreviewStep(makeSeriesPreview());
      expect(useSeriesImportStore.getState().author).toBe('Settings Author');
    });

    it('preview failure lands in the error step', async () => {
      mock.seriesImport.selectFiles.mockResolvedValue(['/tmp/v1.md']);
      mock.seriesImport.preview.mockRejectedValue(new Error('bad docx'));

      await useSeriesImportStore.getState().startImport();

      expect(useSeriesImportStore.getState().step).toBe('error');
      expect(useSeriesImportStore.getState().error).toBe('bad docx');
    });
  });

  describe('volume editing', () => {
    beforeEach(async () => {
      await toPreviewStep();
    });

    it('updateVolumeTitle rewrites the detected title of the matching volume', () => {
      useSeriesImportStore.getState().updateVolumeTitle(1, 'Renamed Volume');
      useSeriesImportStore.getState().updateVolumeTitle(99, 'Nope');

      const titles = useSeriesImportStore.getState().volumes.map((v) => v.preview.detectedTitle);
      expect(titles).toEqual(['Book 1', 'Renamed Volume', 'Book 3']);
    });

    it('toggleVolumeSkip renumbers the remaining volumes', () => {
      useSeriesImportStore.getState().toggleVolumeSkip(0);

      const volumes = useSeriesImportStore.getState().volumes;
      expect(volumes[0].skipped).toBe(true);
      expect(volumes.filter((v) => !v.skipped).map((v) => v.volumeNumber)).toEqual([1, 2]);

      useSeriesImportStore.getState().toggleVolumeSkip(0); // un-skip
      expect(useSeriesImportStore.getState().volumes.map((v) => v.volumeNumber)).toEqual([1, 2, 3]);
    });

    it('moveVolumeUp/Down swap positions, renumber, and ignore boundary moves', () => {
      useSeriesImportStore.getState().moveVolumeUp(0); // top — no-op
      useSeriesImportStore.getState().moveVolumeDown(2); // bottom — no-op
      expect(useSeriesImportStore.getState().volumes.map((v) => v.index)).toEqual([0, 1, 2]);

      useSeriesImportStore.getState().moveVolumeUp(2);
      expect(useSeriesImportStore.getState().volumes.map((v) => v.index)).toEqual([0, 2, 1]);
      expect(useSeriesImportStore.getState().volumes.map((v) => v.volumeNumber)).toEqual([1, 2, 3]);

      useSeriesImportStore.getState().moveVolumeDown(2);
      expect(useSeriesImportStore.getState().volumes.map((v) => v.index)).toEqual([0, 1, 2]);
    });
  });

  describe('commitImport', () => {
    beforeEach(async () => {
      await toPreviewStep();
    });

    it('commits only non-skipped volumes with title fallbacks', async () => {
      useSeriesImportStore.getState().toggleVolumeSkip(1);
      useSeriesImportStore.getState().updateVolumeTitle(2, ''); // force the fallback
      useSeriesImportStore.getState().selectExistingSeries('existing-series');
      mock.seriesImport.commit.mockResolvedValue(seriesResult);

      await useSeriesImportStore.getState().commitImport();

      const config = mock.seriesImport.commit.mock.calls[0][0];
      expect(config.seriesName).toBe('The Storm Cycle');
      expect(config.existingSeriesSlug).toBe('existing-series');
      expect(config.volumes).toHaveLength(2);
      expect(config.volumes.map((v) => v.title)).toEqual(['Book 1', 'Volume 2']);
      expect(config.volumes.map((v) => v.volumeNumber)).toEqual([1, 2]);
      expect(useSeriesImportStore.getState().step).toBe('success');
      expect(useSeriesImportStore.getState().result).toEqual(seriesResult);
    });

    it('is a no-op when every volume is skipped', async () => {
      for (const i of [0, 1, 2]) useSeriesImportStore.getState().toggleVolumeSkip(i);

      await useSeriesImportStore.getState().commitImport();

      expect(mock.seriesImport.commit).not.toHaveBeenCalled();
      expect(useSeriesImportStore.getState().step).toBe('preview');
    });

    it('a failing volume import surfaces as the error step (partial import stays on disk)', async () => {
      mock.seriesImport.commit.mockRejectedValue(new Error('volume 2 failed: bad chapters'));

      await useSeriesImportStore.getState().commitImport();

      expect(useSeriesImportStore.getState().step).toBe('error');
      expect(useSeriesImportStore.getState().error).toBe('volume 2 failed: bad chapters');
    });
  });

  describe('title problems (#79)', () => {
    it('flags taken titles per volume on preview and keeps the wizard open on commit', async () => {
      mock.seriesImport.checkTitles.mockImplementation(async (volumes) =>
        volumes
          .filter((v) => v.title === 'Book 2')
          .map((v) => ({ volumeNumber: v.volumeNumber, message: 'A book titled "Book 2" already exists. Choose another title.' })),
      );

      await toPreviewStep();

      expect(mock.seriesImport.checkTitles).toHaveBeenCalledWith([
        { volumeNumber: 1, title: 'Book 1' },
        { volumeNumber: 2, title: 'Book 2' },
        { volumeNumber: 3, title: 'Book 3' },
      ]);
      // Keyed by the volume's stable index, not its number
      expect(useSeriesImportStore.getState().titleProblems).toEqual({
        1: 'A book titled "Book 2" already exists. Choose another title.',
      });

      await useSeriesImportStore.getState().commitImport();
      expect(mock.seriesImport.commit).not.toHaveBeenCalled();
      expect(useSeriesImportStore.getState().step).toBe('preview');

      // Retitling re-checks and clears the problem
      useSeriesImportStore.getState().updateVolumeTitle(1, 'Book 2, Revised');
      await vi.waitFor(() => expect(useSeriesImportStore.getState().titleProblems).toEqual({}));

      mock.seriesImport.commit.mockResolvedValue(seriesResult);
      await useSeriesImportStore.getState().commitImport();
      expect(useSeriesImportStore.getState().step).toBe('success');
    });

    it('re-checks after skips and moves, ignoring an older answer that arrives late', async () => {
      await toPreviewStep();
      let releaseSlow: (value: { volumeNumber: number; message: string }[]) => void = () => undefined;
      mock.seriesImport.checkTitles
        .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve; }))
        .mockResolvedValueOnce([]);

      useSeriesImportStore.getState().toggleVolumeSkip(0); // slow check
      useSeriesImportStore.getState().moveVolumeDown(1); // fast check, answers first
      await vi.waitFor(() => expect(mock.seriesImport.checkTitles).toHaveBeenCalledTimes(3));

      releaseSlow([{ volumeNumber: 1, message: 'stale' }]);
      await new Promise((r) => setTimeout(r, 0));
      expect(useSeriesImportStore.getState().titleProblems).toEqual({});
    });

    it('a second click while importing does not start a second commit', async () => {
      await toPreviewStep();
      mock.seriesImport.commit.mockResolvedValue(seriesResult);

      await Promise.all([
        useSeriesImportStore.getState().commitImport(),
        useSeriesImportStore.getState().commitImport(),
      ]);

      expect(mock.seriesImport.commit).toHaveBeenCalledTimes(1);
      expect(useSeriesImportStore.getState().step).toBe('success');
    });

    it('treats a failed title check as no problems (the main process re-checks on commit)', async () => {
      mock.seriesImport.checkTitles.mockRejectedValue(new Error('ipc down'));

      await toPreviewStep();

      expect(useSeriesImportStore.getState().titleProblems).toEqual({});
      expect(useSeriesImportStore.getState().step).toBe('preview');
    });
  });

  it('reset restores the initial wizard state', async () => {
    await toPreviewStep();

    useSeriesImportStore.getState().reset();

    expect(useSeriesImportStore.getState()).toMatchObject({
      step: 'idle',
      preview: null,
      result: null,
      error: '',
      seriesName: '',
      author: '',
      volumes: [],
      existingSeriesSlug: null,
    });
  });
});
