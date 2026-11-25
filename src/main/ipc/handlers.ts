import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import type {
  IAuditService,
  IChatService,
  ISettingsService,
  IAgentService,
  IDatabaseService,
  IFileSystemService,
  IPipelineService,
  IBuildService,
  IRevisionQueueService,
  IMotifLedgerService,
  IUsageService,
  IVersionService,
  IProviderRegistry,
  IManuscriptImportService,
  IDataFolderImportService,
  ISeriesService,
  ISourceGenerationService,
  ISeriesImportService,
  IHelperService,
  IFindReplaceService,
  IDashboardService,
  IStatisticsService,
  IClaudeCliUpdateService,
  IFableAccessService,
  IQueryService,
} from '@domain/interfaces';
import type {
  AgentMeta,
  AgentName,
  AppSettings,
  ApprovalAction,
  BookMeta,
  ConversationPurpose,
  MotifLedger,
  PipelinePhaseId,
  QueryStatus,
  QueryTarget,
  QueryTracker,
  QueryLetter,
  QueryFillableField,
  QueueMode,
  SendMessageParams,
  FileVersionSource,
  FindReplaceApplyResult,
  FindReplaceOptions,
  FindReplacePreviewResult,
  StreamEvent,
  StreamEventSource,
  ProviderConfig,
  ProviderId,
  ImportCommitConfig,
  DataFolderImportConfig,
  SeriesImportCommitConfig,
  SeriesMeta,
  SourceGenerationEvent,
  BookDashboardData,
  BookStatistics,
  DataFolderInfo,
  PromptSyncResult,
  PromptSyncStatus,
} from '@domain/types';
import type { NotificationManager } from '../notifications';
import { chooseDataFolder, resetDataFolder } from '../dataFolderDialogs';
import type { EventSink, HostAdapter } from '../host';
import type { IpcRouter } from './router';

/** Every service the handlers delegate to. Built by `composeApp`. */
export interface IpcServices {
  settings: ISettingsService;
  agents: IAgentService;
  db: IDatabaseService;
  fs: IFileSystemService;
  chat: IChatService;
  audit: IAuditService;
  pipeline: IPipelineService;
  build: IBuildService;
  usage: IUsageService;
  revisionQueue: IRevisionQueueService;
  motifLedger: IMotifLedgerService;
  notifications: NotificationManager;
  version: IVersionService;
  providerRegistry: IProviderRegistry;
  manuscriptImport: IManuscriptImportService;
  sourceGeneration: ISourceGenerationService;
  series: ISeriesService;
  seriesImport: ISeriesImportService;
  dataFolderImport: IDataFolderImportService;
  helper: IHelperService;
  findReplace: IFindReplaceService;
  dashboard: IDashboardService;
  statistics: IStatisticsService;
  query: IQueryService;
  claudeCliUpdate: IClaudeCliUpdateService;
  fableAccess: IFableAccessService;
}

export interface IpcPaths {
  userDataPath: string;
  booksDir: string;
  dataFolder: DataFolderInfo;
  promptSync: PromptSyncResult;
}

/**
 * Register every request channel into `router`. Electron-free (#72): dialogs,
 * shell, theme and relaunch go through `host`; push events go through `events`.
 * The transport (Electron `ipcMain`) enforces who may call.
 */
export function registerIpcHandlers(
  router: IpcRouter,
  host: HostAdapter,
  events: EventSink,
  services: IpcServices,
  paths: IpcPaths,
  hooks?: { onActiveBookChanged?: (slug: string) => void },
): void {

  const handle = router.handle.bind(router);

  // === Window controls (custom title bar) — no-ops on a host without windows ===

  router.on('window:minimize', (ctx) => host.windowControl('minimize', ctx));
  router.on('window:maximize', (ctx) => host.windowControl('maximize', ctx));
  router.on('window:close', (ctx) => host.windowControl('close', ctx));
  handle('window:isMaximized', (ctx) => host.isWindowMaximized(ctx));

  /** Files the user picked in a save dialog this session; shell:openPath may open them. */
  const savedExportPaths = new Set<string>();

  /** True when `target` is the books folder or inside it. */
  const isInBooksDir = (target: string): boolean => {
    const root = path.resolve(paths.booksDir);
    const resolved = path.resolve(target);
    return resolved === root || resolved.startsWith(root + path.sep);
  };

  /**
   * Snapshot changed files after a CLI stream completes.
   * Called from chat:send, hot-take, adhoc-revision, and revision queue handlers.
   * Dedup by hash ensures no duplicate versions if the BookWatcher also fires.
   */
  const snapshotChangedFiles = (bookSlug: string, changedPaths: string[], source: FileVersionSource = 'agent') => {
    for (const filePath of changedPaths) {
      services.version.snapshotFile(bookSlug, filePath, source).catch((err) => {
        console.warn('[versions] Auto-snapshot failed for', filePath, err);
      });
    }
  };

  // === Settings ===

  handle('settings:load', () => services.settings.load());

  handle('settings:detectClaudeCli', () => services.settings.detectClaudeCli());

  handle('settings:detectCodexCli', () => services.settings.detectCodexCli());

  // === Claude CLI updates ===

  handle('claudeCli:checkUpdateReminder', () => services.claudeCliUpdate.checkReminder());

  handle('claudeCli:runUpdate', () => services.claudeCliUpdate.runUpdate());

  // On demand only — a successful probe is a billed Fable request.
  handle('claudeCli:checkFableAccess', () => services.fableAccess.check());

  handle('settings:detectOllamaCli', () => services.settings.detectOllamaCli());

  handle('settings:update', async (_, partial: Partial<AppSettings>) => {
    await services.settings.update(partial);

    // Sync the host's native theme when the user changes the appearance setting
    if (partial.theme !== undefined) {
      host.setTheme(partial.theme === 'system' ? 'system' : partial.theme);
    }
  });

  handle('settings:getAvailableModels', () =>
    services.providerRegistry.listAllModels()
  );

  // === Providers ===

  handle('providers:list', () =>
    services.providerRegistry.listProviders()
  );

  handle('providers:getConfig', (_, providerId: ProviderId) =>
    services.providerRegistry.getProviderConfig(providerId)
  );

  handle('providers:add', async (_, config: ProviderConfig) => {
    if (config.type === 'openai-compatible') {
      const { OpenAiCompatibleProvider } = await import('@infra/providers');
      const provider = new OpenAiCompatibleProvider(
        config.id, config.baseUrl ?? '', config.apiKey ?? '', config.capabilities,
      );
      services.providerRegistry.registerProvider(provider, config);
    }
  });

  handle('providers:update', (_, providerId: ProviderId, partial: Partial<ProviderConfig>) =>
    services.providerRegistry.updateProviderConfig(providerId, partial)
  );

  handle('providers:remove', (_, providerId: ProviderId) =>
    services.providerRegistry.removeProvider(providerId)
  );

  handle('providers:checkStatus', (_, providerId: ProviderId) =>
    services.providerRegistry.checkProviderStatus(providerId)
  );

  handle('providers:setDefault', async (_, providerId: ProviderId) => {
    const registry = services.providerRegistry as { setDefaultProvider?: (id: string) => void };
    registry.setDefaultProvider?.(providerId);
    await services.settings.update({ activeProviderId: providerId });
  });

  // === Agents ===

  handle('agents:list', async () => {
    const agents = await services.agents.loadAll();
    return agents.map(({ systemPrompt: _prompt, ...meta }): AgentMeta => meta);
  });

  handle('agents:get', async (_, name: AgentName) => {
    const agent = await services.agents.load(name);
    const { systemPrompt: _prompt, ...meta } = agent;
    return meta as AgentMeta;
  });

  /** Result of this launch's bundled-prompt sync (#39). */
  handle('agents:promptSync', (): PromptSyncStatus => ({
    ...paths.promptSync,
    agentsDir: path.join(paths.userDataPath, 'custom-agents'),
  }));

  // === Data Folder (#39) ===

  handle('dataFolder:get', (): DataFolderInfo => paths.dataFolder);

  /** Pick a folder, confirm, write the pointer and restart. False if cancelled. */
  handle('dataFolder:change', async (ctx): Promise<boolean> => {
    const { source, defaultDir, current } = paths.dataFolder;
    if (source === 'flag' || source === 'env') return false; // overrides always win
    const chosen = await chooseDataFolder(host, ctx, defaultDir, current);
    if (!chosen) return false;
    host.relaunch();
    return true;
  });

  /** Point back at the default folder and restart. False if cancelled. */
  handle('dataFolder:reset', async (ctx): Promise<boolean> => {
    const { source, defaultDir } = paths.dataFolder;
    if (source !== 'pointer') return false; // already default, or overridden
    if (!(await resetDataFolder(host, ctx, defaultDir))) return false;
    host.relaunch();
    return true;
  });

  // === Books ===

  handle('books:list', () => services.fs.listBooks());

  handle('books:getActiveSlug', () => services.fs.getActiveBookSlug());

  handle('books:setActive', async (_, slug: string) => {
    await services.fs.setActiveBook(slug);
    hooks?.onActiveBookChanged?.(slug);
  });

  handle('books:create', async (_, title: string) => {
    const settings = await services.settings.load();
    const meta = await services.fs.createBook(title, settings.authorName);
    hooks?.onActiveBookChanged?.(meta.slug);
    return meta;
  });

  handle('books:findTitleConflict', (_, title: string) =>
    services.fs.findTitleConflict(String(title ?? '')),
  );

  handle('books:getMeta', (_, slug: string) => services.fs.getBookMeta(slug));

  handle('books:updateMeta', async (_, slug: string, partial: Partial<BookMeta>) => {
    const updated = await services.fs.updateBookMeta(slug, partial);
    if (updated.slug !== slug) {
      services.db.updateBookSlug(slug, updated.slug);
      hooks?.onActiveBookChanged?.(updated.slug);
    }
    return updated;
  });

  handle('books:wordCount', (_, slug: string) => services.fs.countWordsPerChapter(slug));

  handle('books:uploadCover', async (ctx, bookSlug: string) => {
    const filePaths = await host.pickFiles({
      title: 'Select Cover Image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    }, ctx);
    if (!filePaths || filePaths.length === 0) return null;
    return services.fs.saveCoverImage(bookSlug, filePaths[0]);
  });

  handle('books:getCoverImagePath', (_, slug: string) =>
    services.fs.getCoverImageAbsolutePath(slug),
  );

  handle('books:getAbsolutePath', (_, bookSlug: string, relativePath: string) =>
    services.fs.getAbsolutePath(bookSlug, relativePath),
  );

  handle('books:archive', async (_, slug: string) => {
    await services.fs.archiveBook(slug);
  });

  handle('books:unarchive', async (_, slug: string) => {
    const meta = await services.fs.unarchiveBook(slug);
    hooks?.onActiveBookChanged?.(meta.slug);
    return meta;
  });

  handle('books:listArchived', () => services.fs.listArchivedBooks());

  handle('books:assembleManuscript', (_e, bookSlug: string) =>
    services.fs.assembleManuscript(bookSlug)
  );

  // === Manuscript Import ===

  handle('import:selectFile', async (ctx) => {
    const filePaths = await host.pickFiles({
      title: 'Import Manuscript',
      filters: [
        { name: 'Manuscripts', extensions: ['md', 'markdown', 'docx'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Word Document', extensions: ['docx'] },
      ],
    }, ctx);

    if (!filePaths || filePaths.length === 0) return null;
    return filePaths[0];
  });

  handle('import:preview', (_, filePath: string) =>
    services.manuscriptImport.preview(filePath),
  );

  handle('import:commit', async (_, config: ImportCommitConfig) => {
    const result = await services.manuscriptImport.commit(config);
    hooks?.onActiveBookChanged?.(result.bookSlug);
    return result;
  });

  handle('import:generateSources', async (_, bookSlug: string) => {
    const broadcastGenProgress = (genEvent: SourceGenerationEvent) => {
      events.broadcast('import:generationProgress', genEvent);
    };

    const broadcastStreamEvent = (streamEvent: StreamEvent) => {
      events.broadcast('chat:streamEvent', {
            ...streamEvent,
            callId: `source-gen:${bookSlug}`,
            conversationId: `source-gen:${bookSlug}`,
            source: 'chat',
          });
    };

    await services.sourceGeneration.generate({
      bookSlug,
      onProgress: broadcastGenProgress,
      onStreamEvent: broadcastStreamEvent,
    });
  });

  // ── Import from another data folder (#37) ─────────────────────────

  handle('import:selectDataFolder', async (ctx) => {
    const filePaths = await host.pickFiles({
      title: 'Import from another Novel Engine folder',
      buttonLabel: 'Choose folder',
      directory: true,
    }, ctx);

    if (!filePaths || filePaths.length === 0) return null;
    return filePaths[0];
  });

  handle('import:dataFolderPreview', (_, sourcePath: string) =>
    services.dataFolderImport.preview(sourcePath),
  );

  handle('import:dataFolderCommit', (_, config: DataFolderImportConfig) =>
    services.dataFolderImport.commit(config),
  );

  // ── Series Import ──────────────────────────────────────────────────

  handle('import:selectFiles', async (ctx) => {
    const filePaths = await host.pickFiles({
      title: 'Import Series — Select Manuscripts',
      filters: [
        { name: 'Manuscripts', extensions: ['md', 'markdown', 'docx'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Word Document', extensions: ['docx'] },
      ],
      multiple: true,
    }, ctx);

    if (!filePaths || filePaths.length === 0) return null;
    return filePaths;
  });

  handle('import:seriesPreview', (_, filePaths: string[]) =>
    services.seriesImport.preview(filePaths),
  );

  handle('import:seriesCheckTitles', (_, volumes: Array<{ volumeNumber: number; title: string }>) =>
    services.seriesImport.checkTitles(volumes),
  );

  handle('import:seriesCommit', async (_, config: SeriesImportCommitConfig) => {
    const result = await services.seriesImport.commit(config);

    // Set the first book as active so the user lands somewhere useful
    if (result.volumeResults.length > 0) {
      hooks?.onActiveBookChanged?.(result.volumeResults[0].bookSlug);
    }

    return result;
  });

  // === Files ===

  handle('files:read', (_, bookSlug: string, path: string) =>
    services.fs.readFile(bookSlug, path),
  );

  handle('files:write', async (_, bookSlug: string, path: string, content: string) => {
    await services.fs.writeFile(bookSlug, path, content);
    // Auto-snapshot the written content (dedup by hash — no-op if unchanged)
    await services.version.snapshotContent(bookSlug, path, content, 'user').catch((err) => {
      console.warn('[versions] Auto-snapshot failed:', err);
    });
  });

  handle('files:exists', (_, bookSlug: string, path: string) =>
    services.fs.fileExists(bookSlug, path),
  );

  handle('files:listDir', (_, bookSlug: string, path?: string) =>
    services.fs.listDirectory(bookSlug, path),
  );

  handle('files:delete', (_, bookSlug: string, relativePath: string) =>
    services.fs.deletePath(bookSlug, relativePath),
  );

  // === Versions ===

  handle('versions:getHistory', (_, bookSlug: string, filePath: string, limit?: number, offset?: number) =>
    services.version.getHistory(bookSlug, filePath, limit ?? 50, offset ?? 0),
  );

  handle('versions:getVersion', (_, versionId: number) =>
    services.version.getVersion(versionId),
  );

  handle('versions:getDiff', (_, oldVersionId: number | null, newVersionId: number) =>
    services.version.getDiff(oldVersionId, newVersionId),
  );

  handle('versions:revert', async (_, bookSlug: string, filePath: string, versionId: number) => {
    const result = await services.version.revertToVersion(bookSlug, filePath, versionId);
    // Notify renderer that a file was changed (revert is a write)
    events.broadcast('chat:filesChanged', [filePath], bookSlug);
    return result;
  });

  handle('versions:getCount', (_, bookSlug: string, filePath: string) =>
    services.version.getVersionCount(bookSlug, filePath),
  );

  handle('versions:snapshot', (_, bookSlug: string, filePath: string, source: FileVersionSource) =>
    services.version.snapshotFile(bookSlug, filePath, source),
  );

  handle('versions:getUserEdits', (_, bookSlug: string, filePath: string) =>
    services.version.getUserEditsSinceAgentBaseline(bookSlug, filePath),
  );

  handle('versions:getChapterEditStatuses', (_, bookSlug: string) =>
    services.version.getChapterEditStatuses(bookSlug),
  );

  // === Conversations ===

  handle('chat:createConversation', (_, params: {
    bookSlug: string;
    agentName: AgentName;
    pipelinePhase: PipelinePhaseId | null;
    purpose?: ConversationPurpose;
  }) => services.chat.createConversation(params));

  handle('chat:getConversations', (_, bookSlug: string) =>
    services.chat.getConversations(bookSlug),
  );

  handle('chat:getMessages', (_, conversationId: string) =>
    services.chat.getMessages(conversationId),
  );

  handle('chat:deleteConversation', (_, conversationId: string) =>
    services.db.deleteConversation(conversationId),
  );

  // === Chat (abort) ===

  handle('chat:abort', (_, conversationId: string) =>
    services.chat.abortStream(conversationId),
  );

  handle('chat:isCliIdle', (_, bookSlug?: string) => services.chat.isCliIdle(bookSlug));

  // === Chat (streaming) ===

  handle('chat:send', async (ctx, params: SendMessageParams) => {

    // Use the renderer-provided callId if available, otherwise generate one.
    // Renderer-generated IDs let stores filter events to their own call,
    // preventing cross-book stream bleed when multiple chats run concurrently.
    const callId = params.callId ?? randomUUID();

    // Track whether the call completed successfully or errored for notification
    let hadError = false;
    let errorText = '';

    /**
     * Broadcast a stream event to ALL open windows (not just the sender).
     *
     * After a renderer refresh (Cmd+R / F5), the original BrowserWindow
     * and its webContents are still alive but the old page context is gone.
     * By broadcasting to every window we guarantee the reloaded page's
     * freshly-registered `ipcRenderer.on('chat:streamEvent')` listener
     * receives events — enabling true live re-subscription.
     */
    const broadcastStreamEvent = (streamEvent: StreamEvent & { callId: string; conversationId: string; source?: StreamEventSource }) => {
      events.broadcast('chat:streamEvent', streamEvent);
    };

    const result = await services.chat.sendMessage({
      ...params,
      callId,
      onEvent: (streamEvent) => {
        if (streamEvent.type === 'error') {
          hadError = true;
          errorText = streamEvent.message;
        }
        // Inject callId + conversationId + source so the renderer can scope events
        // to the correct call and conversation, preventing cross-book bleed
        broadcastStreamEvent({ ...streamEvent, callId, conversationId: params.conversationId, source: 'chat' });
      },
    });

    // Fire OS notification (only shows if window is unfocused + setting enabled)
    if (hadError) {
      services.notifications.notifyChatError(params.agentName, errorText).catch(() => {});
    } else {
      // Resolve book title for a richer notification
      const bookTitle = await services.fs.getBookMeta(params.bookSlug)
        .then((meta) => meta.title)
        .catch(() => undefined);
      services.notifications.notifyChatComplete(params.agentName, bookTitle).catch(() => {});
    }

    // If files were changed during this interaction, notify the renderer.
    // Include the bookSlug so the renderer scopes the pipeline refresh
    // to the correct book — prevents cross-book pipeline bleed.
    // Broadcast to all windows so refreshed renderers also receive the notification.
    const changedFiles = result.changedFiles;
    if (changedFiles.length > 0) {
      events.broadcast('chat:filesChanged', changedFiles, params.bookSlug);
      // Snapshot agent-written files (uses params.bookSlug — correct for any book, not just active)
      snapshotChangedFiles(params.bookSlug, changedFiles);

      // Record word count snapshot after files changed
      services.statistics.recordWordCountSnapshot(params.bookSlug).catch(() => {});
    }
  });

  // === Pipeline ===

  handle('pipeline:detect', (_, bookSlug: string) =>
    services.pipeline.detectPhases(bookSlug),
  );

  handle('pipeline:getActive', (_, bookSlug: string) =>
    services.pipeline.getActivePhase(bookSlug),
  );

  handle('pipeline:markPhaseComplete', (_, bookSlug: string, phaseId: PipelinePhaseId) =>
    services.pipeline.markPhaseComplete(bookSlug, phaseId),
  );

  handle('pipeline:completeRevision', (_, bookSlug: string) =>
    services.pipeline.completeRevision(bookSlug),
  );

  handle('pipeline:confirmAdvancement', (_, bookSlug: string, phaseId: PipelinePhaseId) =>
    services.pipeline.confirmPhaseAdvancement(bookSlug, phaseId),
  );

  handle('pipeline:revertPhase', (_, bookSlug: string, phaseId: PipelinePhaseId) =>
    services.pipeline.revertPhase(bookSlug, phaseId),
  );

  // === Build ===

  handle('build:run', async (ctx, bookSlug: string) => {
    const result = await services.build.build(bookSlug, (message) => {
      ctx.reply('build:progress', message);
    });

    // Fire OS notification for build completion
    if (result.success) {
      const bookTitle = await services.fs.getBookMeta(bookSlug)
        .then((meta) => meta.title)
        .catch(() => bookSlug);
      const successFormats = result.formats.filter((f) => !f.error).length;
      services.notifications.notifyBuildComplete(bookTitle, successFormats).catch(() => {});
    }

    return result;
  });

  handle('build:isPandocAvailable', () => services.build.isPandocAvailable());

  handle('build:exportZip', async (ctx, bookSlug: string) => {
    const distDir = services.fs.getAbsolutePath(bookSlug, 'dist');
    const meta = await services.fs.getBookMeta(bookSlug);
    const slug = meta.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const filePath = await host.saveFile({
      title: 'Export Build Artifacts',
      defaultPath: `${slug}-build.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    }, ctx);

    if (!filePath) return null;
    savedExportPaths.add(path.resolve(filePath));

    return new Promise<string>((resolve, reject) => {
      const output = createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve(filePath));
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(distDir, false);
      archive.finalize();
    });
  });

  // === Catalog Export ===

  handle('catalog:exportZip', async (ctx) => {
    const dateStr = new Date().toISOString().slice(0, 10);

    const filePath = await host.saveFile({
      title: 'Export Book Catalog',
      defaultPath: `novel-engine-catalog-${dateStr}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    }, ctx);

    if (!filePath) return null;
    savedExportPaths.add(path.resolve(filePath));

    return new Promise<string>((resolve, reject) => {
      const output = createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve(filePath));
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(paths.booksDir, 'books');
      archive.finalize();
    });
  });

  // === Usage ===

  handle('usage:summary', (_, bookSlug?: string) => services.usage.getSummary(bookSlug));

  handle('usage:byConversation', (_, conversationId: string) =>
    services.usage.getByConversation(conversationId),
  );

  // === Context Diagnostics ===

  handle('context:getLastDiagnostics', (_, conversationId?: string) =>
    services.chat.getLastDiagnostics(conversationId),
  );

  // === Active Stream (for renderer refresh recovery) ===

  handle('chat:getActiveStream', () => services.chat.getActiveStream());

  handle('chat:getActiveStreamForBook', (_, bookSlug: string) =>
    services.chat.getActiveStreamForBook(bookSlug),
  );

  handle('chat:getOrphanedSessions', () =>
    services.chat.getRecoveredOrphans()
  );

  handle('chat:deepDive', async (ctx, params: { bookSlug: string; chapterSlug: string; conversationId?: string; callId?: string }) => {
    const callId = params.callId ?? randomUUID();
    const broadcastStreamEvent = (streamEvent: StreamEvent & { callId: string; conversationId?: string; source?: string }) => {
      events.broadcast('chat:streamEvent', streamEvent);
    };
    return services.chat.deepDive({
      ...params,
      callId,
      onEvent: (streamEvent) => {
        broadcastStreamEvent({ ...streamEvent, callId, source: 'chat' } as StreamEvent & { callId: string; conversationId?: string; source?: string });
      },
    });
  });

  // === Author Profile ===

  handle('settings:saveAuthorProfile', async (_, content: string) => {
    const profilePath = path.join(paths.userDataPath, 'author-profile.md');
    await fsPromises.writeFile(profilePath, content, 'utf-8');
  });

  handle('settings:loadAuthorProfile', async () => {
    const profilePath = path.join(paths.userDataPath, 'author-profile.md');
    try {
      return await fsPromises.readFile(profilePath, 'utf-8');
    } catch {
      // ENOENT — no author profile yet
      return '';
    }
  });

  // === Shell ===

  handle('shell:openExternal', (_, url: string) => {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error('shell:openExternal needs a valid URL');
    }
    if (protocol !== 'https:' && protocol !== 'mailto:') {
      throw new Error(`shell:openExternal opens only https: and mailto: links (got ${protocol})`);
    }
    return host.openExternal(url);
  });

  // Opens a book file or folder, or an export the user saved this session.
  handle('shell:openPath', (_, absolutePath: string) => {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
      throw new Error('shell:openPath needs an absolute path');
    }
    if (!isInBooksDir(absolutePath) && !savedExportPaths.has(path.resolve(absolutePath))) {
      throw new Error('shell:openPath opens only files in the books folder or exports saved this session');
    }
    return host.openPath(absolutePath);
  });

  // === Shelved Pitches ===

  handle('pitches:list', () => services.fs.listShelvedPitches());

  handle('pitches:read', (_, slug: string) => services.fs.readShelvedPitch(slug));

  handle('pitches:delete', (_, slug: string) => services.fs.deleteShelvedPitch(slug));

  handle('pitches:shelve', (_, bookSlug: string, logline?: string) =>
    services.fs.shelvePitch(bookSlug, logline),
  );

  handle('pitches:restore', async (_, pitchSlug: string, title?: string) => {
    const meta = await services.fs.restorePitch(pitchSlug, typeof title === 'string' ? title : undefined);
    hooks?.onActiveBookChanged?.(meta.slug);
    return meta;
  });

  // === Pitch Room ===

  handle('pitchRoom:listDrafts', () => services.fs.listPitchDrafts());

  handle('pitchRoom:getDraft', (_, convId: string) =>
    services.fs.getPitchDraft(convId),
  );

  handle('pitchRoom:readContent', (_, convId: string) =>
    services.fs.readPitchDraftContent(convId),
  );

  handle('pitchRoom:promote', async (_, convId: string, title?: string) => {
    const meta = await services.fs.promotePitchToBook(convId, typeof title === 'string' ? title : undefined);
    hooks?.onActiveBookChanged?.(meta.slug);
    return meta;
  });

  handle('pitchRoom:shelve', (_, convId: string, logline?: string) =>
    services.fs.shelvePitchDraft(convId, logline),
  );

  handle('pitchRoom:discard', async (_, convId: string) => {
    await services.fs.deletePitchDraft(convId);
    services.db.deleteConversation(convId);
  });

  // === Hot Take ===

  handle('hot-take:start', async (ctx, bookSlug: string) => {
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const conversation = services.db.createConversation({
      id: randomUUID(),
      bookSlug,
      agentName: 'Ghostlight',
      pipelinePhase: null,
      purpose: 'hot-take',
      title: `Hot Take — ${dateStr}`,
    });

    const callId = randomUUID();

    const broadcastStreamEvent = (streamEvent: StreamEvent & { callId: string; conversationId: string; source?: StreamEventSource }) => {
      events.broadcast('chat:streamEvent', streamEvent);
    };

    let hotTakeChangedFiles: string[] = [];
    services.chat.sendMessage({
      agentName: 'Ghostlight',
      message: 'Read the full manuscript and give me your honest reaction.',
      conversationId: conversation.id,
      bookSlug,
      callId,
      onEvent: (streamEvent) => {
        broadcastStreamEvent({ ...streamEvent, callId, conversationId: conversation.id, source: 'hot-take' });

        // Track changed files for version snapshotting
        if (streamEvent.type === 'filesChanged') {
          hotTakeChangedFiles = streamEvent.paths;
        }
        if ((streamEvent.type === 'done' || streamEvent.type === 'error') && hotTakeChangedFiles.length > 0) {
          snapshotChangedFiles(bookSlug, hotTakeChangedFiles);
        }
      },
    }).catch((err) => {
      console.error('[hot-take] Stream error:', err);
    });

    return { conversationId: conversation.id, callId };
  });

  // === Ad Hoc Revision ===

  handle('adhoc-revision:start', async (ctx, bookSlug: string, description: string) => {

    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const conversation = services.db.createConversation({
      id: randomUUID(),
      bookSlug,
      agentName: 'Forge',
      pipelinePhase: null,
      purpose: 'adhoc-revision',
      title: `Ad Hoc Revision — ${dateStr}`,
    });

    const callId = randomUUID();

    const broadcastStreamEvent = (streamEvent: StreamEvent & { callId: string; conversationId: string; source?: StreamEventSource }) => {
      events.broadcast('chat:streamEvent', streamEvent);
    };

    let adhocChangedFiles: string[] = [];
    services.chat.sendMessage({
      agentName: 'Forge',
      message: description,
      conversationId: conversation.id,
      bookSlug,
      callId,
      onEvent: (streamEvent) => {
        broadcastStreamEvent({ ...streamEvent, callId, conversationId: conversation.id, source: 'adhoc-revision' });

        // Track changed files from the stream events directly (per-stream, no singleton)
        if (streamEvent.type === 'filesChanged') {
          adhocChangedFiles = streamEvent.paths;
        }

        if (streamEvent.type === 'done' || streamEvent.type === 'error') {
          if (adhocChangedFiles.length > 0) {
            events.broadcast('chat:filesChanged', adhocChangedFiles, bookSlug);
            // Snapshot agent-written files for this book
            snapshotChangedFiles(bookSlug, adhocChangedFiles);
          }
        }
      },
    }).catch((err) => {
      console.error('[adhoc-revision] Stream error:', err);
    });

    return { conversationId: conversation.id, callId };
  });

  // === Verity Pipeline (audit/fix) ===

  /** Broadcast stream events from audit/fix/motif-audit calls to all renderer windows. */
  const broadcastVerityEvent = (callId: string, conversationId: string, source: StreamEventSource) =>
    (streamEvent: StreamEvent) => {
      const tagged = { ...streamEvent, callId, conversationId, source };
      events.broadcast('chat:streamEvent', tagged);
    };

  /** Emit a synthetic callStart so audit/fix calls appear in the CLI Activity Monitor. */
  const emitVerityCallStart = (callId: string, conversationId: string, bookSlug: string) => {
    const callStartEvent = { type: 'callStart' as const, callId, conversationId, agentName: 'Verity', model: 'unknown', bookSlug };
    events.broadcast('chat:streamEvent', callStartEvent);
  };

  handle('verity:auditChapter', async (_, bookSlug: string, chapterSlug: string, rendererCallId?: string, rendererConversationId?: string) => {
    const callId = rendererCallId ?? `audit:${randomUUID()}`;
    const broadcastConversationId = rendererConversationId ?? `audit-${randomUUID()}`;
    emitVerityCallStart(callId, broadcastConversationId, bookSlug);
    return services.audit.auditChapter({
      bookSlug,
      chapterSlug,
      conversationId: rendererConversationId,
      onEvent: broadcastVerityEvent(callId, broadcastConversationId, 'audit'),
    });
  });

  handle('verity:fixChapter', async (_, bookSlug: string, chapterSlug: string, conversationId: string, rendererCallId?: string) => {
    const sessionId = randomUUID();
    const callId = rendererCallId ?? `fix:${sessionId}`;
    emitVerityCallStart(callId, conversationId, bookSlug);
    await services.audit.fixChapter({
      bookSlug,
      chapterSlug,
      auditResult: { chapter: chapterSlug, violations: [], summary: { total: 0, by_type: {}, severity: 'clean' } },
      conversationId,
      sessionId,
      onEvent: broadcastVerityEvent(callId, conversationId, 'fix'),
    });
  });

  handle('verity:fixChapterWithAudit', async (_, bookSlug: string, chapterSlug: string, conversationId: string, auditResultJson: string, rendererCallId?: string) => {
    const sessionId = randomUUID();
    const callId = rendererCallId ?? `fix:${sessionId}`;
    const auditResult = JSON.parse(auditResultJson);
    emitVerityCallStart(callId, conversationId, bookSlug);
    await services.audit.fixChapter({
      bookSlug,
      chapterSlug,
      auditResult,
      conversationId,
      sessionId,
      onEvent: broadcastVerityEvent(callId, conversationId, 'fix'),
    });
  });

  handle('verity:runMotifAudit', async (_, bookSlug: string, rendererCallId?: string) => {
    const appSettings = await services.settings.load();
    const sessionId = randomUUID();
    const callId = rendererCallId ?? `motif-audit:${sessionId}`;
    emitVerityCallStart(callId, `motif-audit-${sessionId}`, bookSlug);
    await services.audit.runMotifAudit({
      bookSlug,
      appSettings,
      onEvent: broadcastVerityEvent(callId, `motif-audit-${sessionId}`, 'motif-audit'),
      sessionId,
    });
  });

  // === Revision Queue ===

  handle('revision:loadPlan', async (_, bookSlug: string) => {
    return services.revisionQueue.loadPlan(bookSlug);
  });

  handle('revision:clearCache', async (_, bookSlug: string) => {
    await services.revisionQueue.clearCache(bookSlug);
  });

  handle('revision:runSession', async (_, planId: string, sessionId: string) => {
    return services.revisionQueue.runSession(planId, sessionId);
  });

  handle('revision:runAll', async (_, planId: string, selectedSessionIds?: string[]) => {
    return services.revisionQueue.runAll(planId, selectedSessionIds);
  });

  handle('revision:respondToGate', (_, planId: string, sessionId: string, action: string, message?: string) => {
    services.revisionQueue.respondToGate(planId, sessionId, action as ApprovalAction, message);
  });

  handle('revision:approveSession', async (_, planId: string, sessionId: string) => {
    return services.revisionQueue.approveSession(planId, sessionId);
  });

  handle('revision:rejectSession', async (_, planId: string, sessionId: string) => {
    return services.revisionQueue.rejectSession(planId, sessionId);
  });

  handle('revision:skipSession', async (_, planId: string, sessionId: string) => {
    return services.revisionQueue.skipSession(planId, sessionId);
  });

  handle('revision:pause', (_, planId: string) => {
    services.revisionQueue.pause(planId);
  });

  handle('revision:setMode', (_, planId: string, mode: string) => {
    services.revisionQueue.setMode(planId, mode as QueueMode);
  });

  handle('revision:getPlan', (_, planId: string) => {
    return services.revisionQueue.getPlan(planId);
  });

  handle('revision:startVerification', (_, planId: string) =>
    services.revisionQueue.startVerification(planId),
  );


  handle('revision:getQueueStatus', (_, bookSlug: string) => {
    return services.revisionQueue.getQueueStatus(bookSlug);
  });

  // === Motif Ledger ===

  handle('motifLedger:load', (_, bookSlug: string) =>
    services.motifLedger.load(bookSlug),
  );

  handle('motifLedger:save', (_, bookSlug: string, ledger: MotifLedger) =>
    services.motifLedger.save(bookSlug, ledger),
  );

  handle('motifLedger:getUnauditedChapters', (_, bookSlug: string) =>
    services.motifLedger.getUnauditedChapters(bookSlug),
  );

  // Forward revision queue events to all renderer windows + fire OS notifications
  services.revisionQueue.onEvent((event) => {
    events.broadcast('revision:event', event);

    if (event.type === 'session:streamEvent') {
      // Use sessionId as callId so the renderer groups events per revision session
      events.broadcast('chat:streamEvent', {
        ...event.event,
        callId: `rev:${event.sessionId}`,
        conversationId: event.conversationId ?? event.sessionId,
        source: 'revision' as StreamEventSource,
      });
    }

    // Snapshot files changed during revision sessions
    if (event.type === 'session:streamEvent' && event.event.type === 'filesChanged') {
      services.fs.getActiveBookSlug().then((slug) => {
        if (slug) {
          snapshotChangedFiles(slug, event.event.type === 'filesChanged' ? event.event.paths : []);
        }
      }).catch(() => {});
    }

    // Fire notifications for key revision events
    if (event.type === 'session:done') {
      services.notifications.notifyRevisionSessionComplete(
        `Session finished (tasks ${event.taskNumbers.join(', ')})`,
      ).catch(() => {});
    } else if (event.type === 'queue:done') {
      services.notifications.notifyRevisionQueueDone().catch(() => {});
    }
  });

  // === Series ===

  handle('series:list', () => services.series.listSeries());

  handle('series:get', (_e, slug: string) => services.series.getSeries(slug));

  handle('series:create', (_e, name: string, description?: string) =>
    services.series.createSeries(name, description));

  handle('series:update', (_e, slug: string, partial: Partial<Pick<SeriesMeta, 'name' | 'description'>>) =>
    services.series.updateSeries(slug, partial));

  handle('series:delete', (_e, slug: string) => services.series.deleteSeries(slug));

  handle('series:addVolume', (_e, seriesSlug: string, bookSlug: string, volumeNumber?: number) =>
    services.series.addVolume(seriesSlug, bookSlug, volumeNumber));

  handle('series:removeVolume', (_e, seriesSlug: string, bookSlug: string) =>
    services.series.removeVolume(seriesSlug, bookSlug));

  handle('series:reorderVolumes', (_e, seriesSlug: string, orderedSlugs: string[]) =>
    services.series.reorderVolumes(seriesSlug, orderedSlugs));

  handle('series:getForBook', (_e, bookSlug: string) =>
    services.series.getSeriesForBook(bookSlug));

  handle('series:readBible', (_e, seriesSlug: string) =>
    services.series.readSeriesBible(seriesSlug));

  handle('series:writeBible', (_e, seriesSlug: string, content: string) =>
    services.series.writeSeriesBible(seriesSlug, content));

  // === Helper ===

  handle('helper:getOrCreateConversation', async () => {
    return services.helper.getOrCreateConversation();
  });

  handle('helper:getMessages', async (_e, conversationId: string) => {
    return services.helper.getMessages(conversationId);
  });

  handle('helper:send', async (_e, params: { message: string; conversationId: string; callId?: string }) => {
    const { message, conversationId, callId } = params;
    const resolvedCallId = callId ?? randomUUID();
    await services.helper.sendMessage({
      message,
      conversationId,
      callId: resolvedCallId,
      onEvent: (event) => {
        events.broadcast('chat:streamEvent', {
              ...event,
              callId: resolvedCallId,
              conversationId,
              source: 'chat' as StreamEventSource,
            });
      },
    });
  });

  handle('helper:abort', async (_e, conversationId: string) => {
    services.helper.abortStream(conversationId);
  });

  handle('helper:reset', async () => {
    await services.helper.resetConversation();
  });

  // === Find & Replace ===

  handle('findReplace:preview', async (_, bookSlug: string, searchTerm: string, options: FindReplaceOptions): Promise<FindReplacePreviewResult> =>
    services.findReplace.preview(bookSlug, searchTerm, options),
  );

  handle('findReplace:apply', async (_, params: {
    bookSlug: string;
    searchTerm: string;
    replacement: string;
    filePaths: string[];
    options: FindReplaceOptions;
  }): Promise<FindReplaceApplyResult> =>
    services.findReplace.apply(params),
  );

  // === Dashboard ===

  handle('dashboard:getData', async (_event, bookSlug: string): Promise<BookDashboardData> =>
    services.dashboard.getDashboardData(bookSlug),
  );

  // === Statistics ===

  handle('statistics:get', async (_event, bookSlug?: string): Promise<BookStatistics> =>
    services.statistics.getStatistics(bookSlug),
  );

  handle('statistics:recordSnapshot', async (_event, bookSlug: string): Promise<void> =>
    services.statistics.recordWordCountSnapshot(bookSlug),
  );

  // === Query Manager ===

  handle('query:loadTracker', (_, bookSlug: string) =>
    services.query.loadTracker(bookSlug),
  );

  handle('query:saveTracker', (_, bookSlug: string, tracker: QueryTracker) =>
    services.query.saveTracker(bookSlug, tracker),
  );

  handle('query:addTarget', (_, bookSlug: string, target: Omit<QueryTarget, 'id' | 'queryLetterPath' | 'submittedDate' | 'responseDate'>) =>
    services.query.addTarget(bookSlug, target),
  );

  handle('query:updateTargetStatus', (_, bookSlug: string, targetId: string, status: QueryStatus, responseDate?: string) =>
    services.query.updateTargetStatus(bookSlug, targetId, status, responseDate),
  );

  handle('query:removeTarget', (_, bookSlug: string, targetId: string) =>
    services.query.removeTarget(bookSlug, targetId),
  );

  const broadcastQueryStreamEvent = (streamEvent: StreamEvent, callId: string) => {
    events.broadcast('query:onStream', streamEvent);
    events.broadcast('chat:streamEvent', { ...streamEvent, callId, conversationId: callId, source: 'query' as StreamEventSource });
  };

  handle('query:generateLetter', async (_event, bookSlug: string, targetId: string) => {
    const callId = `query:generate:${randomUUID().slice(0, 8)}`;
    const result = await services.query.generateQueryLetter(bookSlug, targetId, (streamEvent) => {
      broadcastQueryStreamEvent(streamEvent, callId);
    });
    if (result && result.filePath) {
      snapshotChangedFiles(bookSlug, [result.filePath]);
    }
    return result;
  });

  handle('query:listLetters', (_, bookSlug: string) =>
    services.query.listQueryLetters(bookSlug),
  );

  handle('query:readLetter', (_, bookSlug: string, targetSlug: string) =>
    services.query.readQueryLetter(bookSlug, targetSlug),
  );

  handle('query:saveLetter', (_, bookSlug: string, targetSlug: string, content: string) =>
    services.query.saveQueryLetter(bookSlug, targetSlug, content),
  );

  handle('query:researchTargets', async (_event, bookSlug: string) => {
    const callId = `query:research:${randomUUID().slice(0, 8)}`;
    const result = await services.query.researchTargets(bookSlug, (streamEvent) => {
      broadcastQueryStreamEvent(streamEvent, callId);
    });
    return result;
  });

  handle('query:fillTargetField', async (_event, bookSlug: string, targetId: string, field: QueryFillableField) => {
    const callId = `query:fill:${randomUUID().slice(0, 8)}`;
    const result = await services.query.fillTargetField(bookSlug, targetId, field, (streamEvent) => {
      broadcastQueryStreamEvent(streamEvent, callId);
    });
    return result;
  });
}
