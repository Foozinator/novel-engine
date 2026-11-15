# Architecture — Novel Engine Spur

> Last updated: 2026-11-15 (#37, after #39)

Electron + React 18 + TypeScript 5 + Tailwind v4 + Zustand + better-sqlite3 + Claude Code CLI + Codex CLI + Ollama CLI + Pandoc

See domain-specific docs:
- [Domain](./DOMAIN.md) — Types, interfaces, constants
- [Infrastructure](./INFRASTRUCTURE.md) — Database, filesystem, CLI, settings, agents, Pandoc
- [Application](./APPLICATION.md) — Services and orchestration
- [IPC](./IPC.md) — Channels, preload bridge, handler registry
- [Renderer](./RENDERER.md) — Stores, components, views

---

## Layers

```
DOMAIN ← INFRASTRUCTURE ← APPLICATION ← IPC/MAIN ← RENDERER
```

- **Domain** (`src/domain/`) — Pure types. Zero imports. Everything depends on this.
- **Infrastructure** (`src/infrastructure/`) — Implements domain interfaces. Isolated modules.
- **Application** (`src/application/`) — Orchestrates infrastructure through injected interfaces.
- **Main/IPC** (`src/main/`, `src/preload/`) — Composition root + thin IPC adapters.
- **Renderer** (`src/renderer/`) — React + Zustand. Talks to backend only through preload bridge.

---

## Source Tree

```
src/
├── domain/                                  # LAYER 1: Pure types, zero imports
│   ├── types.ts                             # All shared type definitions
│   ├── interfaces.ts                        # Service contracts (ports)
│   ├── constants.ts                         # Agent registry, pipeline phases, defaults, quick actions, status messages
│   └── index.ts                             # Barrel export
│
├── infrastructure/                          # LAYER 2: Implements domain interfaces
│   ├── settings/
│   │   ├── SettingsService.ts               # CLI detection, preferences, JSON persistence
│   │   ├── claudeModelMigration.ts          # One-time dated-ID → CLI alias settings migration
│   │   └── index.ts
│   ├── database/
│   │   ├── schema.ts                        # SQLite CREATE TABLE statements, WAL mode, foreign keys
│   │   ├── DatabaseService.ts               # Conversations, messages, usage, stream events repos
│   │   ├── bookHistory.ts                   # Per-book history snapshot export/merge (#37, #36 seam)
│   │   ├── SourceDataFolder.ts              # Opens another data folder via a migrated temp DB copy
│   │   └── index.ts
│   ├── agents/
│   │   ├── AgentService.ts                  # Reads agent .md files from disk, composite loading
│   │   └── index.ts
│   ├── filesystem/
│   │   ├── FileSystemService.ts             # Book CRUD, file I/O, shelved pitches, pitch room
│   │   ├── BookWatcher.ts                   # Watches active book dir for file changes
│   │   ├── BooksDirWatcher.ts               # Watches books/ root for new/deleted books
│   │   └── index.ts
│   ├── claude-cli/
│   │   ├── ClaudeCodeClient.ts              # Spawns `claude` process, streams NDJSON, lifecycle
│   │   ├── StreamSessionTracker.ts          # Tracks active stream sessions for orphan recovery
│   │   ├── ClaudeCliUpdater.ts              # `claude --version` / `claude update` (refused while busy)
│   │   ├── FableProbe.ts                    # On-demand minimal request to the `fable` alias
│   │   └── index.ts
│   ├── codex-cli/
│   │   ├── CodexCliClient.ts                # Spawns `codex exec --json`, streams events, lifecycle
│   │   └── index.ts
│   ├── ollama-cli/
│   │   ├── OllamaCodeClient.ts              # Uses Ollama `/api/chat` for streaming and tool-use loops
│   │   ├── OllamaCliRunner.ts               # Wraps `ollama` detection, list/show, serve, and smoke tests
│   │   ├── ToolExecutor.ts                  # Executes Ollama tool calls (Read/Write/Edit/LS/Bash/WebSearch)
│   │   ├── WebSearcher.ts                  # DuckDuckGo HTML web search for Ollama/llama-server agents
│   │   ├── contextCompactor.ts              # Compacts long Ollama tool context
│   │   ├── tools.ts                         # Ollama tool schemas and types (includes WebSearch)
│   │   └── index.ts
│   ├── llama-server/
│   │   ├── LlamaServerClient.ts             # OpenAI-compatible llama-server provider
│   │   └── index.ts
│   ├── providers/
│   │   ├── ProviderRegistry.ts              # Provider registration, routing, and persistence
│   │   ├── OpenAiCompatibleProvider.ts      # Generic OpenAI-compatible streaming provider
│   │   └── index.ts
│   ├── pandoc/
│   │   └── index.ts                         # Pandoc binary path resolution (dev vs packaged)
│   └── series/
│       ├── SeriesService.ts                 # File-based series CRUD, reverse-lookup cache
│       └── index.ts
│
├── application/                             # LAYER 3: Business logic, depends on interfaces
│   ├── ContextBuilder.ts                    # Assembles context per agent read guidance + conversation compaction
│   ├── ChatService.ts                       # Full send→stream→save orchestration (via CLI)
│   ├── ChapterValidator.ts                  # Validates/corrects chapter file placement
│   ├── PipelineService.ts                   # Phase detection from file existence + book status
│   ├── BuildService.ts                      # Pandoc execution for DOCX/EPUB/PDF
│   ├── UsageService.ts                      # Token tracking, cost estimation
│   ├── RevisionQueueService.ts              # Parses Forge output, executes revision sessions
│   ├── MotifLedgerService.ts                # Motif ledger CRUD from JSON on disk
│   ├── VersionService.ts                   # File versioning: snapshot, diff, revert, prune
│   ├── ManuscriptImportService.ts           # DOCX/MD import, chapter detection, book creation
│   ├── SeriesImportService.ts              # Batch import + series creation orchestration
│   ├── DataFolderImportService.ts           # Import books + history from another data folder
│   ├── SourceGenerationService.ts           # Multi-agent source document generation
│   ├── HelperService.ts                     # In-app help assistant (user guide as context)
│   ├── FindReplaceService.ts               # Bulk find & replace across chapter drafts; safe revert via snapshots
│   ├── AutoTurnResumer.ts                  # Decorator: auto-resumes provider calls on max-turns exhaustion
│   ├── ClaudeCliUpdateService.ts           # Weekly Claude CLI update reminder + runs the update
│   ├── FableAccessService.ts               # On-demand Fable access check; adds Fable to Claude models
│   ├── QueryService.ts                    # Query tracker I/O, target CRUD, AI query letter generation via Quill
│   ├── import/
│   │   └── ChapterDetector.ts               # Pure chapter break detection utility
│   ├── context/
│   │   ├── readAuthorProfile.ts             # Reads the author profile for inlining ('' if missing)
│   │   ├── readRules.ts                     # AGENT_READ_GUIDANCE path matching (never-read and read-step filters, chapter-notes rule)
│   │   └── TokenEstimator.ts                # Pure token counting utility
│   └── index.ts                             # Barrel export
│
├── main/                                    # LAYER 4: Electron main process
│   ├── index.ts                             # COMPOSITION ROOT — instantiates everything
│   ├── bootstrap.ts                         # First-run directory/file creation; ensureAgents() bundled-prompt sync
│   ├── dataLocation.ts                      # Resolves the data folder (flag › env › pointer › default); pointer I/O
│   ├── dataFolderDialogs.ts                 # Native dialogs: startup data-folder checks, change/reset from Settings
│   ├── notifications.ts                     # OS notification manager
│   └── ipc/
│       └── handlers.ts                      # Thin adapter: IPC channel → service call
│
├── preload/
│   └── index.ts                             # contextBridge: typed API for renderer
│
└── renderer/                                # LAYER 5: React UI
    ├── App.tsx                              # Root component, onboarding gate
    ├── main.tsx                             # React 18 createRoot entry
    ├── stores/
    │   ├── settingsStore.ts
    │   ├── bookStore.ts
    │   ├── chatStore.ts
    │   ├── pipelineStore.ts
    │   ├── viewStore.ts
    │   ├── tourStore.ts                  # Tour lifecycle: start, complete, dismiss, replay
    │   ├── pitchRoomStore.ts
    │   ├── pitchShelfStore.ts
    │   ├── revisionQueueStore.ts
    │   ├── autoDraftStore.ts
    │   ├── cliActivityStore.ts
    │   ├── cliUpdateStore.ts              # Claude CLI update banner state
    │   ├── fileChangeStore.ts
    │   ├── modalChatStore.ts
    │   ├── motifLedgerStore.ts
    │   ├── queryStore.ts                   # Query tracker/submission state
    │   ├── importStore.ts
    │   ├── dataFolderImportStore.ts        # Import-from-another-data-folder wizard state
    │   ├── helperStore.ts                # In-app help assistant panel state
    │   └── streamHandler.ts              # Shared stream event handler factory
    ├── tours/
    │   └── tourDefinitions.ts            # Step arrays for welcome, first-book, pipeline-intro tours
    ├── components/
    │   ├── common/                          # Tooltip, GuidedTourOverlay
    │   ├── Layout/                          # AppLayout, Sidebar, TitleBar, ResizeHandle
    │   ├── Onboarding/                      # OnboardingWizard
    │   ├── Settings/                        # SettingsView
    │   ├── Sidebar/                         # BookPanel, PipelineTracker, ImportChoiceModal, action buttons
    │   ├── Chat/                            # ChatView, MessageBubble, ThinkingBlock, ChatInput, etc.
    │   ├── Files/                           # FilesView (5-tab), FileBrowser, FileEditor
    │   ├── Build/                           # BuildView
    │   ├── PitchRoom/                       # PitchRoomView
    │   ├── RevisionQueue/                   # RevisionQueueView, SessionCard, TaskProgress, etc.
    │   ├── MotifLedger/                     # MotifLedgerView + tabs (Entries, Systems, Foreshadow, etc.)
    │   ├── Import/                          # ImportWizard, ChapterPreviewList, ImportSeriesWizard, VolumePreviewList, DataFolderImportWizard
    │   ├── CliActivity/                     # CliActivityPanel
    │   ├── CliUpdate/                       # CliUpdateBanner
    │   ├── Helper/                          # HelperButton, HelperPanel, HelperMessageList
    │   ├── ErrorBoundary/                   # ErrorBoundary
    │   ├── PipelineSpine/                   # PipelineSpine, PhaseNode, stages
    │   └── QueryManager/                    # QueryManagerView, TargetCard, AddTargetForm, LetterPreview, FilterBar
    ├── hooks/
    │   ├── useProseZoom.ts             # Ctrl+wheel / Ctrl+=/-/0 prose font size
    │   ├── useResizeHandle.ts
    │   ├── useRevisionQueueEvents.ts
    │   ├── useRotatingStatus.ts
    │   ├── useTheme.ts
    │   ├── useTooltip.ts                 # Tooltip positioning, delays, viewport clamping
    │   └── useVerticalResize.ts
    └── styles/
        └── globals.css
```

---

## Service Dependencies

Composition root: `src/main/index.ts`

```
SettingsService(userDataPath)
DatabaseService(dbPath)
AgentService(agentsDir)
FileSystemService(booksDir, userDataPath)
ClaudeCodeClient(booksDir, db)
CodexCliClient(booksDir, db)
OllamaCliRunner()
OllamaCodeClient(booksDir, db, savedOllamaConfig?.baseUrl, ollamaCliRunner)
LlamaServerClient(booksDir, db, savedLlamaConfig?.baseUrl)
ProviderRegistry(settings)
AutoTurnResumer(providerRegistry)  ← wraps ProviderRegistry; all services receive the wrapper

UsageService
└── IDatabaseService (DatabaseService)

ChapterValidator(booksDir)

ChatService
├── ISettingsService (SettingsService)
├── IAgentService (AgentService)
├── IDatabaseService (DatabaseService)
├── IProviderRegistry (AutoTurnResumer → ProviderRegistry)
├── IFileSystemService (FileSystemService)
├── UsageService
└── ChapterValidator

PipelineService
└── IFileSystemService (FileSystemService)

BuildService
├── IFileSystemService (FileSystemService)
├── pandocPath: string
└── booksDir: string

RevisionQueueService
├── IFileSystemService (FileSystemService)
├── IProviderRegistry (AutoTurnResumer → ProviderRegistry)
├── IAgentService (AgentService)
├── IDatabaseService (DatabaseService)
└── ISettingsService (SettingsService)

MotifLedgerService
└── IFileSystemService (FileSystemService)

VersionService
├── IDatabaseService (DatabaseService)
└── IFileSystemService (FileSystemService)

ManuscriptImportService
├── IFileSystemService (FileSystemService)
└── pandocPath: string

SeriesImportService
├── IManuscriptImportService (ManuscriptImportService)
└── ISeriesService (SeriesService)

DataFolderImportService
├── IDatabaseService (DatabaseService)
├── ISeriesService (SeriesService)
├── OpenSourceDataFolder (makeSourceDataFolderOpener → DatabaseService on a temp copy)
├── paths: { userDataPath, booksDir, tmpRoot: os.tmpdir() }
└── defaultAuthorProfile: AUTHOR_PROFILE_TEMPLATE (bootstrap.ts)

SourceGenerationService
├── ISettingsService (SettingsService)
├── IAgentService (AgentService)
├── IDatabaseService (DatabaseService)
├── IFileSystemService (FileSystemService)
└── IProviderRegistry (ProviderRegistry)

HelperService
├── ISettingsService (SettingsService)
├── IAgentService (AgentService)
├── IDatabaseService (DatabaseService)
├── IFileSystemService (FileSystemService)
├── IProviderRegistry (AutoTurnResumer → ProviderRegistry)
├── StreamManager
└── userDataPath: string

FindReplaceService
├── IFileSystemService (FileSystemService)
└── IVersionService (VersionService)

QueryService
├── IFileSystemService (FileSystemService)
└── IChatService (ChatService)

NotificationManager
└── ISettingsService (SettingsService)

FableAccessService
├── ISettingsService (SettingsService)
├── IFableProbe (FableProbe)
└── IProviderRegistry (ProviderRegistry)

BookWatcher(booksDir, callback)
BooksDirWatcher(booksDir, callback)
```

---

## Conventions

### Path Aliases

| Alias | Maps To |
|-------|---------|
| `@domain/*` | `src/domain/*` |
| `@infra/*` | `src/infrastructure/*` |
| `@app/*` | `src/application/*` |

### File Naming

- Domain types: `PascalCase` type names in `camelCase.ts` files
- Infrastructure: `PascalCaseService.ts` implementing `IPascalCaseService`
- Application: `PascalCaseService.ts`
- Components: `PascalCase.tsx` in `PascalCase/` directories
- Stores: `camelCaseStore.ts`
- Barrel exports: `index.ts` in every infrastructure subdirectory

### Renderer Value Import Exception

The renderer layer normally uses `import type` only from domain. However, **pure data constants and pure functions with zero Node.js dependencies** may be imported as values. This avoids routing static configuration through the IPC bridge unnecessarily.

**Criteria for allowed value imports:**
- Zero Node.js imports (no `fs`, `path`, `child_process`, etc.)
- No side effects (no I/O, no global state mutation)
- Statically defined data or pure functions

**Allowed imports from `@domain/constants`:**
- `AGENT_REGISTRY`, `PIPELINE_PHASES`, `CREATIVE_AGENT_NAMES`
- `AGENT_QUICK_ACTIONS`, `AVAILABLE_MODELS`
- `CHARS_PER_TOKEN`, `PITCH_ROOM_SLUG`

**Allowed imports from `@domain/statusMessages`:**
- `randomRespondingStatus()`, `randomPitchRoomFlavor()`

**NOT allowed from renderer:**
- Infrastructure classes, application services, or any module with I/O

### Security

- `contextIsolation: true` — always
- `nodeIntegration: false` — always
- No API keys stored — Claude Code CLI handles its own authentication
- All renderer↔main communication through the preload bridge
- Custom `novel-asset://` protocol for serving local files (cover images) to renderer

### Data Folder

`{userData}` below is the **data folder**. All app data derives from it. `src/main/index.ts` resolves it before `app.whenReady()` with `resolveDataDir()` (`src/main/dataLocation.ts`) and calls `app.setPath('userData', …)` when it differs from Electron's default. Priority:

1. `--data-dir=<absolute path>` command-line flag
2. `NOVEL_ENGINE_DATA_DIR` environment variable
3. Pointer file `data-location.json` in Electron's **default** userData folder (`{ "dataDir": string | null, "confirmed": true }`), written by Settings → Data Folder or the startup dialogs
4. Electron's default userData folder, named after `productName` (`%APPDATA%\Novel Engine Spur`, `~/.config/Novel Engine Spur`, `~/Library/Application Support/Novel Engine Spur`)

Chromium `sessionData` follows `userData`, so renderer localStorage is per data folder. An unusable folder (relative, not a folder, not writable, malformed pointer) triggers a startup dialog before bootstrap. On first launch with no pointer, no app data in Spur's default folder, and app data in the pre-rename `{appData}/Novel Engine` folder (`LEGACY_DATA_FOLDER_NAME`, which upstream installs still use), the app asks once: copy it into the default folder (`copyAppData()`, which skips Chromium profile files and the pointer and never overwrites), use it in place (pointer → legacy folder, relaunch), or start fresh. Upstream ignores `data-location.json`.

### Product Identity

The fork ships as **Novel Engine Spur** (`APP_NAME` in `src/domain/constants.ts`, `productName` in `package.json`). Packaging IDs all differ from upstream so both install side by side: executable `novel-engine-spur`, bundle ID `io.github.foozinator.novel-engine-spur`, Squirrel `NovelEngineSpur`, deb/rpm `novel-engine-spur`, artifacts `Novel-Engine-Spur-{version}-{platform}-{arch}.{ext}`. Code identifiers and on-disk names keep the original name so data folders stay compatible with upstream: `window.novelEngine`, `novel-engine.db`, `novel-asset://`, `novel-engine:*` localStorage keys, `NOVEL_ENGINE_DATA_DIR`.

### Book Directory Structure

```
{userData}/
├── books/
│   └── {slug}/
│       ├── about.json              # BookMeta
│       ├── source/                 # Agent output files
│       │   ├── pitch.md
│       │   ├── voice-profile.md
│       │   ├── scene-outline.md
│       │   ├── story-bible.md
│       │   ├── reader-report.md
│       │   ├── dev-report.md
│       │   ├── audit-report.md
│       │   ├── project-tasks.md
│       │   ├── revision-prompts.md
│       │   ├── style-sheet.md
│       │   ├── motif-ledger.json
│       │   ├── metadata.md
│       │   ├── query-tracker.md           # Query submission tracker
│       │   └── query-letters/              # Per-target query letter files
│       ├── chapters/
│       │   └── NN-slug/
│       │       ├── draft.md
│       │       └── notes.md
│       └── dist/                   # Build outputs
├── custom-agents/                  # Agent .md prompt files
│   └── .bundled-manifest.json      # Bundled hash each prompt was installed from (prompt sync)
├── data-location.json             # Pointer to the data folder (default folder only)
├── author-profile.md              # Global author profile
├── active-book.json               # { "book": "slug-name" }
├── settings.json                  # AppSettings
└── novel-engine.db                # SQLite database
```

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Shell | Electron | 33.4.0 |
| Bundler | Vite (via Electron Forge) | ^5.4.21 |
| Framework | React | ^18.3.0 |
| Language | TypeScript | ~5.5.0 |
| Styling | Tailwind CSS | ^4.0.0 |
| State | Zustand | ^5.0.0 |
| Database | better-sqlite3 | ^11.0.0 |
| AI Backend | Claude Code CLI, Codex CLI | (system-installed) |
| Build | Pandoc | (bundled binary) |
| IDs | nanoid | 3 |
| Markdown | marked | ^15.0.0 |
| Archive | archiver | ^7.0.1 |
| Build Tool | Electron Forge | ^7.11.1 |
