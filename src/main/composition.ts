import path from 'node:path';
import { tmpdir } from 'node:os';

// Infrastructure
import { SettingsService } from '@infra/settings';
import { DatabaseService, makeSourceDataFolderOpener } from '@infra/database';
import { AgentService } from '@infra/agents';
import { FileSystemService, BookWatcher, BooksDirWatcher } from '@infra/filesystem';
import { ClaudeCodeClient, ClaudeCliUpdater, FableProbe } from '@infra/claude-cli';
import { CodexCliClient } from '@infra/codex-cli';
import { OllamaCodeClient, OllamaCliRunner } from '@infra/ollama-cli';
import { LlamaServerClient } from '@infra/llama-server';
import { ProviderRegistry, OpenAiCompatibleProvider } from '@infra/providers';
import { resolvePandocPath } from '@infra/pandoc';
import { SeriesService } from '@infra/series';
import { BUILT_IN_PROVIDER_CONFIGS, OLLAMA_CLI_PROVIDER_ID, LLAMA_SERVER_PROVIDER_ID, CODEX_CLI_PROVIDER_ID } from '@domain/constants';
import type { ModelInfo, PromptSyncResult } from '@domain/types';

// Application
import { AuditService } from '@app/AuditService';
import { ChatService } from '@app/ChatService';
import { HotTakeService } from '@app/HotTakeService';
import { AdhocRevisionService } from '@app/AdhocRevisionService';
import { PitchRoomService } from '@app/PitchRoomService';
import { HelperService } from '@app/HelperService';
import { StreamManager } from '@app/StreamManager';
import { ChapterValidator } from '@app/ChapterValidator';
import { PipelineService } from '@app/PipelineService';
import { RunLogService } from '@app/RunLogService';
import { ShadowPipelineService } from '@app/ShadowPipelineService';
import { BuildService } from '@app/BuildService';
import { UsageService } from '@app/UsageService';
import { RevisionQueueService } from '@app/RevisionQueueService';
import { MotifLedgerService } from '@app/MotifLedgerService';
import { VersionService } from '@app/VersionService';
import { ManuscriptImportService } from '@app/ManuscriptImportService';
import { SourceGenerationService } from '@app/SourceGenerationService';
import { SeriesImportService } from '@app/SeriesImportService';
import { DataFolderImportService } from '@app/DataFolderImportService';
import { FindReplaceService } from '@app/FindReplaceService';
import { DashboardService } from '@app/DashboardService';
import { StatisticsService } from '@app/StatisticsService';
import { ClaudeCliUpdateService } from '@app/ClaudeCliUpdateService';
import { FableAccessService } from '@app/FableAccessService';
import { QueryService } from '@app/QueryService';
import { AutoTurnResumer } from '@app/AutoTurnResumer';

import type { EventSink, HostAdapter } from './host';
import type { IpcServices } from './ipc/handlers';
import { NotificationManager } from './notifications';
import { bootstrap, needsBootstrap, ensureAgents, ensureUserGuide, AUTHOR_PROFILE_TEMPLATE } from './bootstrap';
import { makeShadowReporter } from './shadowLog';
import { fetchCodexModels, fetchLlamaServerModels, fetchOllamaModels, normalizeCodexModels } from './modelDiscovery';

/**
 * Composition root (#72). Builds every service from resolved paths, a
 * `HostAdapter` and an `EventSink`. It imports no `electron`, so the desktop
 * app and a headless server share it. Each runtime supplies:
 *
 * - the paths (`userDataPath`, bundled agents, user guide, resources),
 * - a `HostAdapter` for dialogs, shell, notifications, theme and relaunch,
 * - an `EventSink` that carries push events to its clients.
 *
 * It does not register IPC handlers or open windows; the caller does that with
 * what this returns.
 */

export interface CompositionOptions {
  /** Root of all app data: DB, books, agents, settings. */
  userDataPath: string;
  /** Folder holding the Pandoc binary (see `resolvePandocPath`). */
  resourcesPath: string;
  /** Bundled agent prompts, copied into `{userData}/custom-agents`. */
  agentsSourceDir: string;
  /** Bundled user guide, copied for the Helper agent. */
  guideSourcePath: string;
  host: HostAdapter;
  events: EventSink;
}

export interface Composition {
  services: IpcServices;
  booksDir: string;
  /** Result of this launch's bundled-prompt sync (#39). */
  promptSync: PromptSyncResult;
  /** Call when the active book changes so the file watcher follows it. */
  onActiveBookChanged: (slug: string) => void;
  /** Stop watchers and close the database. Safe to call twice. */
  dispose: () => void;
}

export async function composeApp(options: CompositionOptions): Promise<Composition> {
  const { userDataPath, resourcesPath, agentsSourceDir, guideSourcePath, host, events } = options;

  // 1a. Bootstrap (first run only)
  if (await needsBootstrap(userDataPath)) {
    await bootstrap(userDataPath, agentsSourceDir);
  }

  // 1b. Sync bundled agent prompts every launch: copies missing ones and
  //     updates the ones the user hasn't edited (#39). Edited prompts are kept
  //     and reported to Settings → Agent Prompts.
  const promptSync = await ensureAgents(path.join(userDataPath, 'custom-agents'), agentsSourceDir);
  if (promptSync.updated.length > 0) console.log('[bootstrap] Updated agent prompts:', promptSync.updated.join(', '));

  // 1c. Copy user guide for the Helper agent (always overwrite to keep current)
  await ensureUserGuide(userDataPath, guideSourcePath);

  // 2. Resolve paths
  const booksDir = path.join(userDataPath, 'books');
  const agentsDir = path.join(userDataPath, 'custom-agents');
  const dbPath = path.join(userDataPath, 'novel-engine.db');
  const pandocPath = resolvePandocPath(resourcesPath);

  // 3. Instantiate infrastructure
  const settings = new SettingsService(userDataPath);
  // Snapshot to {userData}/backups before any schema migration (#58). If the
  // snapshot fails this throws `MigrationBackupError` and the caller decides
  // how to stop.
  const db = new DatabaseService(dbPath, { migrationBackupDir: path.join(userDataPath, 'backups') });
  const agents = new AgentService(agentsDir);
  const fs = new FileSystemService(booksDir, userDataPath);
  // Agents' file tools reach the books, the series bibles and the author profile.
  const claudeClient = new ClaudeCodeClient(booksDir, db, {
    extraToolScopes: [`${path.join(userDataPath, 'series')}/**`, fs.getAuthorProfilePath()],
    loadSettings: () => settings.load(),
  });

  // 3b. Initialize provider registry
  const providerRegistry = new ProviderRegistry(settings);

  // Register the built-in Claude CLI provider
  const appSettings = await settings.load();
  const claudeConfig = appSettings.providers.find(p => p.id === 'claude-cli');
  providerRegistry.registerProvider(
    claudeClient,
    claudeConfig ?? BUILT_IN_PROVIDER_CONFIGS[0],
  );

  // Register the built-in Codex CLI provider (always registered so the user
  // can see and configure it even if the CLI is not installed yet)
  const savedCodexConfig = appSettings.providers.find(p => p.id === CODEX_CLI_PROVIDER_ID);
  const codexClient = new CodexCliClient(booksDir, db);
  const codexBaseConfig = savedCodexConfig
    ?? BUILT_IN_PROVIDER_CONFIGS.find(p => p.id === CODEX_CLI_PROVIDER_ID)!;

  const codexAvailable = await codexClient.isAvailable();
  const codexModels = codexAvailable
    ? await fetchCodexModels(codexBaseConfig.models)
    : normalizeCodexModels(codexBaseConfig.models);
  await settings.update({ hasCodexCli: codexAvailable });
  if (codexAvailable) {
    console.log(`[startup] Codex CLI detected — ${codexModels.length} model(s) available`);
  } else {
    console.log('[startup] Codex CLI not found — provider registered for configuration');
  }

  providerRegistry.registerProvider(codexClient, {
    ...codexBaseConfig,
    enabled: codexAvailable,
    models: codexModels,
    defaultModel: codexBaseConfig.defaultModel ?? codexModels[0]?.id,
  });

  // Register the built-in Ollama CLI provider (always registered so the user
  // can configure the endpoint in Settings even if Ollama isn't reachable yet)
  const savedOllamaConfig = appSettings.providers.find(p => p.id === OLLAMA_CLI_PROVIDER_ID);
  const ollamaCliRunner = new OllamaCliRunner();
  const ollamaClient = new OllamaCodeClient(booksDir, db, savedOllamaConfig?.baseUrl, ollamaCliRunner);
  const ollamaBaseConfig = savedOllamaConfig
    ?? BUILT_IN_PROVIDER_CONFIGS.find(p => p.id === OLLAMA_CLI_PROVIDER_ID)!;

  const ollamaCliAvailable = await ollamaCliRunner.detect();
  const ollamaAvailable = await ollamaClient.isAvailable();
  let ollamaModels: ModelInfo[] = [];
  await settings.update({ hasOllamaCli: ollamaCliAvailable });
  if (ollamaAvailable) {
    ollamaModels = await fetchOllamaModels(ollamaClient.getBaseUrl(), ollamaCliRunner);
    console.log(`[startup] Ollama detected at ${ollamaClient.getBaseUrl()} — ${ollamaModels.length} model(s) available`);
  } else {
    console.log(`[startup] Ollama not reachable at ${ollamaClient.getBaseUrl()} — provider registered for configuration`);
  }

  providerRegistry.registerProvider(ollamaClient, {
    ...ollamaBaseConfig,
    enabled: ollamaAvailable,
    models: ollamaModels,
    defaultModel: ollamaModels[0]?.id,
  });

  // Register the built-in llama-server provider (always registered so the user
  // can configure the endpoint in Settings even if llama-server isn't running yet)
  const savedLlamaConfig = appSettings.providers.find(p => p.id === LLAMA_SERVER_PROVIDER_ID);
  const llamaClient = new LlamaServerClient(booksDir, db, savedLlamaConfig?.baseUrl);
  const llamaBaseConfig = savedLlamaConfig
    ?? BUILT_IN_PROVIDER_CONFIGS.find(p => p.id === LLAMA_SERVER_PROVIDER_ID)!;

  const llamaAvailable = await llamaClient.isAvailable();
  let llamaModels: ModelInfo[] = [];
  if (llamaAvailable) {
    llamaModels = await fetchLlamaServerModels(llamaClient.getBaseUrl());
    console.log(`[startup] llama-server detected at ${llamaClient.getBaseUrl()} — ${llamaModels.length} model(s) available`);
  } else {
    console.log(`[startup] llama-server not reachable at ${llamaClient.getBaseUrl()} — provider registered for configuration`);
  }

  providerRegistry.registerProvider(llamaClient, {
    ...llamaBaseConfig,
    enabled: llamaAvailable,
    models: llamaModels,
    defaultModel: llamaModels[0]?.id,
  });

  // Initialize user-configured providers from settings
  for (const config of appSettings.providers) {
    if (config.id === 'claude-cli') continue;
    if (config.id === CODEX_CLI_PROVIDER_ID) continue; // already registered above
    if (config.id === OLLAMA_CLI_PROVIDER_ID) continue; // already registered above
    if (config.id === LLAMA_SERVER_PROVIDER_ID) continue; // already registered above
    if (!config.enabled) continue;

    if (config.type === 'openai-compatible') {
      const provider = new OpenAiCompatibleProvider(
        config.id,
        config.baseUrl ?? 'http://localhost:11434',
        config.apiKey ?? '',
        config.capabilities,
      );
      providerRegistry.registerProvider(provider, config);
    }
  }

  providerRegistry.setDefaultProvider(appSettings.activeProviderId);
  try {
    const resolved = providerRegistry.resolveModelSelection(appSettings.model, appSettings.activeProviderId);
    if (resolved.didFallback || resolved.providerId !== appSettings.activeProviderId) {
      await settings.update({ model: resolved.model, activeProviderId: resolved.providerId });
      providerRegistry.setDefaultProvider(resolved.providerId);
      console.warn(`[startup] Repaired stale model selection: ${resolved.requestedModel} -> ${resolved.model}`);
    }
  } catch (err) {
    console.error('[startup] Failed to reconcile model selection:', err);
  }

  const providers = new AutoTurnResumer(providerRegistry);

  // 3.5 Auto-reconcile any book folders whose name diverged from the
  //      title stored in about.json (e.g. after a direct on-disk edit).
  //      This runs once at startup before the window opens, so it is
  //      transparent to the user.
  try {
    const slugMigrations = await fs.reconcileBookSlugs();
    for (const { oldSlug, newSlug } of slugMigrations) {
      db.updateBookSlug(oldSlug, newSlug);
    }
  } catch (err) {
    console.warn('[startup] reconcileBookSlugs failed:', err);
  }

  // 4. Instantiate application services
  const usage = new UsageService(db);
  const chapterValidator = new ChapterValidator(booksDir);
  const streamManager = new StreamManager(db, usage);
  const audit = new AuditService(settings, agents, providers, db, fs, usage);
  const pitchRoom = new PitchRoomService(agents, providers, db, fs, streamManager);
  const hotTake = new HotTakeService(agents, providers, db, fs, streamManager);
  const adhocRevision = new AdhocRevisionService(agents, audit, providers, db, fs, streamManager);
  const series = new SeriesService(userDataPath);
  const version = new VersionService(db, fs);
  const chat = new ChatService(settings, agents, db, providers, fs, chapterValidator, pitchRoom, hotTake, adhocRevision, streamManager, series, version);
  // Run log in shadow mode (#87): PipelineService still decides; the log
  // is migrated on open, mirrors each action and is checked on each detect.
  const runLog = new RunLogService(fs);
  const pipeline = new ShadowPipelineService(
    new PipelineService(fs),
    runLog,
    makeShadowReporter(userDataPath).report,
  );
  const build = new BuildService(fs, pandocPath, booksDir);
  const revisionQueue = new RevisionQueueService(fs, providers, agents, db, settings, version);
  const motifLedger = new MotifLedgerService(fs, providers, settings);
  motifLedger.setNormalizationCallback((status, error) => {
    events.broadcast('motifLedger:normalizing', status, error);
  });
  const findReplace = new FindReplaceService(fs, version);
  const manuscriptImport = new ManuscriptImportService(fs, pandocPath);
  const seriesImport = new SeriesImportService(manuscriptImport, series, fs);
  const dataFolderImport = new DataFolderImportService(
    db,
    series,
    makeSourceDataFolderOpener(userDataPath, tmpdir()),
    { userDataPath, booksDir, tmpRoot: tmpdir() },
    AUTHOR_PROFILE_TEMPLATE,
  );
  const sourceGeneration = new SourceGenerationService(settings, agents, db, fs, providers);
  const helper = new HelperService(settings, agents, db, fs, providers, streamManager, userDataPath);
  const dashboard = new DashboardService(db, fs, pipeline);
  const statistics = new StatisticsService(db, fs);
  // `claude update` is refused while any Claude CLI process is running.
  const claudeCliUpdate = new ClaudeCliUpdateService(
    settings,
    new ClaudeCliUpdater(() => claudeClient.hasActiveProcesses()),
  );
  // Fable access is checked only on demand from Settings: the probe is billed.
  const fableAccess = new FableAccessService(settings, new FableProbe(), providerRegistry);
  const queryService = new QueryService(fs, chat);
  const notifications = new NotificationManager(settings, host);

  // 4b. Recover orphaned stream sessions and prune old event data
  try {
    await chat.recoverOrphanedSessions();
  } catch (err) {
    console.warn('[startup] recoverOrphanedSessions failed:', err);
  }
  try {
    db.pruneStreamEvents(7);
  } catch (err) {
    console.warn('[startup] pruneStreamEvents failed:', err);
  }

  // Prune old file versions (keep last 50 per file per book)
  try {
    const books = await fs.listBooks();
    for (const book of books) {
      await version.pruneVersions(book.slug, 50);
    }
  } catch (err) {
    console.warn('[startup] pruneFileVersions failed:', err);
  }

  // 5. Sync the host's native theme with the user preference (affects window frame color)
  host.setTheme(appSettings.theme === 'system' ? 'system' : appSettings.theme);

  // 6. File system watchers
  //    a) Active-book watcher — notifies clients when files change inside the open book
  const bookWatcher = new BookWatcher(booksDir, async (changedPaths) => {
    events.broadcast('chat:filesChanged', changedPaths);

    // Fallback snapshot: catches external edits and manual file drops for active book.
    // Primary agent-write capture is in the IPC handlers (chat:send, hot-take, etc.)
    // which have the correct bookSlug for any book, not just the active one.
    const activeSlug = await fs.getActiveBookSlug().catch(() => '');
    if (activeSlug) {
      for (const changedPath of changedPaths) {
        version.snapshotFile(activeSlug, changedPath, 'agent').catch(() => {
          // Snapshot failure is non-critical
        });
      }
    }
  });

  // Start watching the active book (if one is set)
  const openBook = (slug: string) => {
    bookWatcher.watch(slug);
    pipeline.openBook(slug);
  };
  fs.getActiveBookSlug().then((activeSlug) => {
    if (activeSlug) {
      openBook(activeSlug);
    }
  }).catch(() => {
    // No active book yet — watcher will start when user selects one
  });

  //    b) Books-dir watcher — notifies clients when a new book directory is
  //       added or removed while the app is running (e.g. manual folder copy)
  const booksDirWatcher = new BooksDirWatcher(booksDir, () => {
    events.broadcast('books:changed');
    // Invalidate series reverse-lookup cache when books change
    series.invalidateCache();
  });
  await booksDirWatcher.start();

  let disposed = false;
  return {
    services: {
      settings, agents, db, fs, chat, audit, pipeline, build, usage, revisionQueue, motifLedger,
      notifications, version, providerRegistry: providers, manuscriptImport, sourceGeneration,
      series, seriesImport, dataFolderImport, helper, findReplace, dashboard, statistics,
      query: queryService, claudeCliUpdate, fableAccess,
    },
    booksDir,
    promptSync,
    onActiveBookChanged: openBook,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      bookWatcher.stop();
      booksDirWatcher.stop();
      db.close();
    },
  };
}
