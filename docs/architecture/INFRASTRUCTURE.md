# Infrastructure — Implementations

> Last updated: 2026-11-28 (#87)

Everything in `src/infrastructure/`. Implements domain interfaces using Node.js builtins and npm packages.

---

## Modules

### settings/ — App Preferences & CLI Detection

| File | Purpose |
|------|---------|
| `SettingsService.ts` | Implements `ISettingsService`. JSON at `{userData}/settings.json`. |
| `claudeModelMigration.ts` | `migrateClaudeModelAliases(settings)`. Pure one-time migration from dated Claude IDs to CLI aliases. |
| `index.ts` | Barrel export |

Key behavior:
- Constructor takes `userDataPath: string`
- In-memory cache invalidated on write
- `detectClaudeCli()` runs `claude --version` with timeout
- `detectCodexCli()` runs non-interactive `codex --version` with timeout and persists `hasCodexCli`
- `detectOllamaCli()` runs `ollama --version` with timeout and persists `hasOllamaCli`
- Settings merged with `DEFAULT_SETTINGS` on load (forward-compatible)
- On load, `migrateClaudeModelAliases()` runs. If the saved claude-cli provider lists none of `opus`/`sonnet`/`haiku`, it drops `LEGACY_CLAUDE_CLI_MODEL_IDS` from that provider, prepends the aliases, keeps user-added IDs, and moves `model`/`secondaryModel`/`defaultModel` to `opus`/`sonnet` only where they still name a legacy ID. The migrated settings are written back once. A failed write is logged and retried on the next load.

### lock/ — Data Folder Lock (#75)

| File | Purpose |
|------|---------|
| `DataFolderLock.ts` | `acquireDataFolderLock(dir, appName)`, `readHolderInfo()`, `describeHolder()` |
| `index.ts` | Barrel export |

Key behavior:
- Holds `BEGIN EXCLUSIVE` on `{dataDir}/instance.lock` (a small SQLite file, `timeout: 0`) for the life of the process. The OS drops the lock when the process dies, so a crash or force-removed container leaves nothing to clear.
- `{dataDir}/instance.lock.json` holds app name, host, PID and start time. It is used only for the "folder in use" message, never to decide whether the folder is free (a recreated container has a new hostname and often the same PID).
- Returns `{ acquired: true, release }` or `{ acquired: false, holder }`. Other errors throw.
- Limits: upstream builds don't take the lock, and file locks may not work across VM or network file shares. A lock failure other than BUSY is logged and startup continues.

### database/ — SQLite Persistence

| File | Purpose |
|------|---------|
| `schema.ts` | CREATE TABLE statements, WAL mode, foreign keys, migration guards |
| `migrations.ts` | Forward-only `MIGRATIONS` list (v0–v5) and `runMigrations(db)`. A migration runs its `sql`, or its `apply(db)` function when set (used for idempotent `ADD COLUMN` and for skipping a missing table). Also `APP_SCHEMA_VERSION` and `readAppliedVersion(db)` (-1 without `schema_version`; creates nothing). |
| `backup.ts` | Pre-migration snapshot (#58): `backupBeforeMigrations`, `pruneMigrationBackups`, `MigrationBackupError` |
| `DatabaseService.ts` | Implements `IDatabaseService`. Prepared statements for all queries. |
| `bookHistory.ts` | Per-book history snapshots: export, merge, revert, stats (#37; the seam for #36 archives) |
| `SourceDataFolder.ts` | `makeSourceDataFolderOpener`: opens another data folder via a migrated temp copy of its DB |
| `index.ts` | Barrel export (`DatabaseService`, `makeSourceDataFolderOpener`, `MigrationBackupError`) |

Key behavior:
- WAL mode + foreign keys enabled at connection time
- Prepared statements stored as class members for reuse
- Explicit snake_case → camelCase mapping in every query method
- `pruneStreamEvents(olderThanDays)` deletes old event data
- `persistStreamEventBatch()` wraps inserts in a transaction for bulk efficiency
- `updateBookSlug` migrates conversation references on slug rename. It does not rewrite `file_versions`, `word_count_snapshots` or `stream_sessions` (known gap, spike #36).

Pre-migration snapshot (`backup.ts`, #58):
- `new DatabaseService(dbPath, { migrationBackupDir })` calls `backupBeforeMigrations` on the fresh connection, before `initializeSchema`. Only `src/main/composition.ts` passes the option (`{userData}/backups`). Tests and the `SourceDataFolder` temp copy don't.
- Skipped when `readAppliedVersion(db) >= APP_SCHEMA_VERSION`, or when the DB has no tables (a new file).
- Writes `novel-engine-pre-v<from>-to-v<to>-<ISO timestamp, ':' and '.' → '-'>.db` with `VACUUM INTO`. `from` is `unversioned` for a DB without `schema_version`. The copy is one file and includes WAL pages from other connections.
- Then keeps the newest `MIGRATION_BACKUPS_KEPT` (3) by the timestamp in the name. Other files in the folder are left alone. A failed prune only logs a warning.
- A failed snapshot throws `MigrationBackupError`. `DatabaseService` closes the connection without migrating. Main shows an error box and exits with code 1.

Per-book history snapshot (`bookHistory.ts`):
- The snapshot is a standalone SQLite file. It holds `conversations`, `messages` and `token_usage` (both selected through the book's conversation ids), `file_versions`, `word_count_snapshots`, and a copy of `schema_version`. Stream tables are excluded.
- Export: `ATTACH` the new file, then `CREATE TABLE … AS SELECT` per table in one transaction. Refuses an existing file.
- Import: `ATTACH` the snapshot and check that all six tables exist and that `schema_version ≤ APP_SCHEMA_VERSION`. Then one transaction runs `INSERT … SELECT` over the columns both sides share:
  - Conversation and message TEXT ids are kept.
  - Integer ids are reassigned, in source id order.
  - `book_slug` is set to the target slug.
  - Merged `file_versions.file_path` values with `\` get `/` (snapshots older than v5).
  - Any PK clash rolls back the whole merge.
- The receipt records the conversation ids and the first new `file_versions` / `word_count_snapshots` ids, so `revertBookHistoryImport` can undo the merge.

Source data folder (`SourceDataFolder.ts`):
- Requires `novel-engine.db` and `books/`. Refuses the app's own userData (compared by `realpath`).
- Copies `novel-engine.db` and `-wal` (not `-shm`) into `mkdtemp(tmpRoot)`. It reads the pre-migration `schema_version` with a raw connection, then opens the copy with `DatabaseService`, which migrates the copy.
- The source files are never opened, so even a live WAL source stays byte-for-byte unchanged.
- `close()` closes the copy and removes the temp dir.

### agents/ — Agent Prompt Loader

| File | Purpose |
|------|---------|
| `AgentService.ts` | Implements `IAgentService`. Reads .md files from disk, matches against AGENT_REGISTRY. |
| `index.ts` | Barrel export |

Key behavior:
- `loadAll()` reads every agent file from the `custom-agents/` directory
- `load(name)` returns a single `Agent` with full `systemPrompt`
- `loadComposite(base, supplements)` concatenates base + supplement files (used for Verity phase-specific prompts)
- `loadRaw(filename)` reads any file from agents directory by filename

### filesystem/ — Book I/O & Watchers

| File | Purpose |
|------|---------|
| `FileSystemService.ts` | Implements `IFileSystemService`. Book CRUD, file read/write, directory listing, shelved pitches, pitch room drafts. |
| `bookPaths.ts` | `resolveBookPath(booksDir, slug, rel)`: joins under `<booksDir>/<slug>`, throws on a slug that isn't one folder name or a result outside the book. `toPortablePath(rel, sep = path.sep)`: converts the platform separator to `/` (a `\` in a POSIX file name is kept). `safeSegment(value, what)` for pitch slugs and draft IDs. |
| `BookWatcher.ts` | Watches active book dir for file changes, debounced notifications. Reports book-relative paths with `/`. |
| `BooksDirWatcher.ts` | Watches `books/` root for new/deleted books (folder add/remove). |
| `index.ts` | Barrel export |

Key behavior:
- `FileSystemService` constructor takes `booksDir` and `userDataPath`
- `createBook` generates slug from title (`slugifyBookTitle`), creates directory structure with `about.json`. It never writes into an existing book (#79): it throws `describeBookTitleConflict()` when `findTitleConflict(title)` finds one, then claims the folder with a non-recursive `mkdir` so a folder that appears after the check fails with `EEXIST`
- `findTitleConflict(title)` scans `books/` and `books/_archived/`: an entry whose name lowercases to the slug, or whose `about.json` title slugifies to it. Reserved `_`/`.` folders are skipped. It reads every `about.json`, so it is O(books)
- `getBookMeta` throws when `about.json` is missing, isn't valid JSON, or isn't a JSON object
- `updateBookMeta` writes the five `BookMeta` fields (`title`, `author`, `status`, `created`, `coverImage`) over the parsed `about.json`. Other keys (genre, subgenre, audience, comp titles written by agents) keep their values and their position. Unknown keys in the `partial` are ignored. A title that changes the slug renames the folder first, after the same check as `createBook` (live and archived, any case), skipping the book's own folder
- `restorePitch(pitchSlug, title?)` and `promotePitchToBook(conversationId, title?)` take an optional replacement title for when the pitch's own title is taken
- `reconcileBookSlugs` renames folders whose name no longer matches the slugified title
- `saveCoverImage` copies image into book directory, updates `about.json` through `updateBookMeta`
- `archiveBook`/`unarchiveBook` moves books to/from `_archived/` subdirectory; `unarchiveBook` removes the book's `.claude/` folder
- Every book-relative path goes through `resolveBookPath()` (read/write/delete/rename/exists/list, covers, word counts, manifest). Pitch slugs and draft IDs go through `safeSegment()`. A `coverImage` outside the book reads as no cover
- `writeFile` refuses to overwrite a binary file (#83). Paths that pass `isTextFilePath()` skip the check. For any other path it reads the first 8192 bytes of the existing file; a NUL or invalid UTF-8 throws `Not a text file: … was left unchanged`. Missing files are created as before
- `appendFile` (#87) appends with `fs.appendFile` after the same `resolveBookPath()` and binary checks as `writeFile`; it creates the file and its folders. Used for the run log (`pipeline-log.jsonl`)
- `listDirectory` file entries carry `size` (bytes) from the `stat` the tree walk already makes
- `listDirectory` entry paths use `/` on every platform (`buildFileTree` passes them through `toPortablePath()`), so they match the `chapters/<slug>/draft.md` keys in version history
- Shelved pitches stored in `books/_pitches/{slug}.md` with YAML front matter
- Pitch Room drafts stored in `books/__pitch-room__/drafts/{conversationId}/`
- `BookWatcher.watch(slug)` switches which book directory is being monitored
- `BooksDirWatcher.start()` watches for folder-level changes in `books/`

### claude-cli/ — CLI Client

| File | Purpose |
|------|---------|
| `ClaudeCodeClient.ts` | Implements `IClaudeClient` and `IModelProvider`. Spawns `claude` CLI as child process, streams NDJSON responses. Exposes `providerId` (`'claude-cli'`) and `capabilities` (`text-completion`, `tool-use`, `thinking`, `streaming`). |
| `StreamSessionTracker.ts` | Tracks active stream sessions for orphan detection/recovery. |
| `ClaudeCliUpdater.ts` | Implements `IClaudeCliUpdater`. `getVersion()` parses `claude --version`; `update()` runs `claude update` (180s timeout) and re-reads the version → `updated` / `up-to-date` / `failed` (with stdout+stderr) / `busy` (an injected `isBusy()` — the composition root passes `claudeClient.hasActiveProcesses()`; a running `claude.exe` blocks the update on Windows) / `not-installed`. |
| `FableProbe.ts` | Implements `IFableProbe`. Runs `claude -p` against the `fable` alias with the cheapest flag set available on subscription auth (`FABLE_PROBE_ARGS`: replacement `--system-prompt`, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`), cwd `os.tmpdir()`, 60s timeout. `classifyFableProbeOutput()` → `unavailable` (CLI model-access message) / `available` (JSON with `is_error !== true`) / `error` (timeout, missing CLI, other). |
| `index.ts` | Barrel export |

Key behavior:
- Spawns `claude` with flags: `--output-format stream-json`, `--max-turns`, `--model`, `--system-prompt`
- Optional `--thinking-budget` for extended thinking
- Working directory set to book directory (CLI tools operate on book files)
- Parses NDJSON line-by-line from stdout
- Maps CLI events to `StreamEvent` union variants
- Resolved model: the `system`/`init` event's `model` (e.g. `opus` → `claude-opus-5-5`) is stored on the `StreamSessionTracker`, emitted once as `modelResolved`, and attached to `done` as `model`
- CLI session: the `system`/`init` event's `session_id` (a UUID) is emitted as `cliSession`. With `resumeCliSessionId` set, the client adds `--resume <id>` and sends only the new user message on stdin; the CLI reloads the session's transcript, tool results included. IDs that aren't UUIDs are refused with an `error` event before spawning
- Bash limits: a `## Bash Limits` note listing `CLAUDE_CLI_ALLOWED_BASH_COMMANDS` is appended to every system prompt file, since `--system-prompt-file` replaces Claude Code's own prompt and print mode can't approve other commands. With WebFetch off, a line saying so follows it
- Constructor: `(booksDir, db, options?)`. `options.extraToolScopes` adds Read/Write/Edit scopes (the composition root passes `{userData}/series/**` and `{userData}/author-profile.md`); `options.loadSettings` is read at each spawn for `allowWebFetch`
- The system prompt file lives in a fresh `mkdtemp` directory (`novel-engine-sysprompt-*`, 0700; file 0600), removed when the CLI exits
- A `bookSlug` that isn't one folder name is refused with an `error` event before spawning (unless an explicit `workingDir` is given)
- `abortStream` sends SIGTERM, then SIGKILL after 2s grace period
- `isAvailable()` caches result of `claude --version` check
- Persists stream events to SQLite in batches (100ms flush interval, max 20, critical events flush immediately) for reduced I/O pressure
- `hasActiveProcesses()` / `hasActiveProcessesForBook()` for idle detection
- EPIPE/ERR_STREAM_DESTROYED on stdin logged with diagnostic info (stdinBytes, writableFinished, writableEnded)
- System prompt size guard: rejects prompts > 500KB with clear error before spawn
- Max-turns signaling: emits `isMaxTurns: true` on the `error` StreamEvent when the CLI result subtype is `error_max_turns` (vs. `false` for other error subtypes like `error_during_execution`). That error also carries `usage` (the exhausted attempt's `StreamUsage`) so `AutoTurnResumer` counts it.
- Usage from the result event: `inputTokens` ← `usage.input_tokens` (uncached only), `cacheReadTokens` ← `usage.cache_read_input_tokens`, `cacheWriteTokens` ← `usage.cache_creation_input_tokens`. `costUsd` comes from `extractRunCostUsd()`: the sum of `model_usage_since_last_result[*].costUSD` (this run only). `total_cost_usd` is cumulative over the CLI session, so it is used only as a fallback on runs without `--resume` (`StreamSessionTracker.isResumedRun()`).
- Error label: `Claude CLI run failed (<subtype>): <result>`. The subtype is omitted when it is `success`, because a result can carry `subtype: "success"` with `is_error: true` (e.g. an API 400 "this CLI version does not support the model").


### codex-cli/ — Codex CLI Provider

| File | Purpose |
|------|---------|
| `CodexCliClient.ts` | Implements `IModelProvider`. Spawns `codex exec --json` non-interactively, streams JSONL/text into `StreamEvent`s, tracks active child processes. |
| `index.ts` | Barrel export |

Key behavior:
- Exposes `providerId` as `'codex-cli'` and capabilities: `text-completion`, `streaming`, `tool-use`, `thinking`
- `isAvailable()` caches a non-interactive `codex --version` check with a 10s timeout
- Startup registration in `src/main/composition.ts` enables Codex when `CodexCliClient.isAvailable()` succeeds and persists `hasCodexCli`
- Model discovery reads `~/.codex/models_cache.json` defensively, then falls back to built-in `gpt-5.3-codex`
- Builds an explicit workspace plan before spawn: active-book `cwd` for book conversations, `booksDir` for root calls, or the caller-provided `workingDir`
- Validates the planned working directory exists before spawning `codex`; missing paths emit an `error` stream event and abort launch
- Spawns `codex exec --json --enable standalone_web_search --sandbox workspace-write --skip-git-repo-check --cd <workingDir> --output-last-message <tempFile>` and appends `--add-dir <booksDir>` only when `codex exec --help` reports support and the working directory is not already `booksDir`; the `--enable standalone_web_search` flag activates Codex's native `web_search` tool so Quill's Query Manager research flow works without configuration
- Falls back to `-c 'sandbox_workspace_write.writable_roots=["<booksDir>"]'` for older Codex CLI installs without `--add-dir` (verified against codex-cli 0.27.0 via `codex debug seatbelt`), so the books root is always writable
- Reads the temporary `--output-last-message` file on clean close when JSON stdout contained no assistant text, emits that fallback as `textDelta`, then deletes the temp directory
- Writes the assembled prompt to stdin; no shell interpolation or interactive login/setup commands
- Parses JSONL in `--json` mode; non-JSON stdout is captured as bounded diagnostics instead of assistant text
- Unwraps the Codex 0.27.0 `{"id":"0","msg":{...}}` event envelope (also `event`/`data` keys) for text, status, usage, and error extraction; streams `agent_message`/`*_delta` text with a delta-duplicate guard; labels type-less config/prompt echo lines as `config-echo`/`prompt-echo`
- Records mid-task `token_count` usage without ending the turn; `turn.completed` and `task_complete` are terminal and emit `done` (falling back to the last recorded `token_count` usage, then `CHARS_PER_TOKEN` estimates)
- Codex JSON diagnostics include compact `eventTail` shape summaries for unknown events (for example `unknown{msg,data}`) and bounded `unknownJsonTail` raw snippets capped to the last five unknown JSON objects
- Tracks completed Codex tool/file items, including `file_change` events, through `StreamSessionTracker` and emits `toolUse`, zero-duration `toolDuration`, `progressStage`, `done.filesTouched`, and one terminal `filesChanged` event for touched paths
- Captures a bounded metadata-only workspace snapshot before spawn and diffs it on clean close when parsed Codex events did not report touched files; skips `.git`, `node_modules`, `dist`, `out`, and `.vite`, capped at 5,000 files
- Treats clean file-only exits as success when Codex writes files but emits no assistant text or usage; emits a concise updated-files text block plus synthetic `done.filesTouched`
- Classifies transient `stream_error` events (the CLI retries internally) as `status` events with the recorded reason; terminal `error` envelopes set the failure message so rejections carry the real cause
- Retries fully-empty transient stream failures (no text streamed, no files touched, no `done`) by re-spawning up to `CODEX_STREAM_RETRY_MAX` times with linear `CODEX_STREAM_RETRY_DELAY_MS` backoff; emits exactly one `error` StreamEvent when the run finally gives up
- Failure diagnostics include exit code, signal, elapsed time, workspace mode, JSON event count, parsed event tail, `streamError=` last transient reason, last status, stderr tail, and stdout tail
- Persists stream events to SQLite in batches and supports `abortStream()` with SIGTERM then SIGKILL after 2s; a Stop during retry backoff cancels the pending re-spawn
- `hasActiveProcesses()` / `hasActiveProcessesForBook()` mirror the Claude provider idle checks
- Recognizes built-in Codex `web_search` item events as `WebSearch` tool-use events; `extractToolFilePath` returns the `action.query` or `query` field as the search-term surrogate for CLI Activity display

### ollama-cli/ — Ollama CLI/API Hybrid Provider

| File | Purpose |
|------|---------|
| `OllamaCodeClient.ts` | Implements `IModelProvider`. Uses Ollama `/api/chat` for streaming text, thinking, and tool-use loops. |
| `OllamaCliRunner.ts` | Wraps the local `ollama` command for CLI detection, model listing, model context inspection, `ollama serve` lifecycle, and smoke tests. |
| `ToolExecutor.ts` | Executes Ollama tool calls sandboxed to the working directory plus additional allowed roots (constructor: `(bookDir, additionalRoots = [])` — clients pass the books dir for Pitch Room scaffolding). Supports `WebSearch` via `WebSearcher` for query-manager research. |
| `BashEmulator.ts` | Emulates the whitelisted Bash commands (mkdir/cat/mv/cp/ls/find/wc/rm/rmdir) with Node fs APIs — no shell spawned, metacharacters rejected, paths sandboxed via `ToolExecutor.resolveSafe`. |
| `WebSearcher.ts` | DuckDuckGo HTML-based web search executor for Ollama/llama-server agents. No API key required, best-effort parsing. Returns formatted text results suitable for model context. |
| `tools.ts` | Ollama tool schema definitions and tool-call types (Read, Write, Edit, LS, Bash, WebSearch — full Claude CLI parity including web search). |
| `contextCompactor.ts` | Compacts tool context for long Ollama agent loops. |
| `index.ts` | Barrel export |

Key behavior:
- `OllamaCodeClient.isAvailable()` is CLI-first for local endpoints: detect the `ollama` binary, check `/api/tags`, attempt `ollama serve`, then accept CLI-listed models as provider availability if the API is still down.
- `OllamaCodeClient.sendMessage()` keeps `/api/chat` for structured streaming and tool-use responses, but first ensures the local API is reachable for localhost/127.0.0.1 endpoints.
- Remote/non-local Ollama endpoints stay HTTP-first through `/api/tags` and `/api/show`; local CLI fallback is not used for remote hosts.
- `OllamaCliRunner.detect()` runs `ollama --version` and returns `false` on missing CLI or command failure.
- `OllamaCliRunner.listModels()` parses `ollama list`, skips the `NAME ID SIZE MODIFIED` header, and returns `[]` on missing CLI or empty output.
- `OllamaCliRunner.showModelContext()` tries `ollama show <model> --json`, then falls back to defensive text parsing for context length patterns.
- `OllamaCliRunner.startServe()` spawns `ollama serve` once and warns, rather than throwing, if the process exits because the service is already running.
- `OllamaCliRunner.runSmokeTest()` pipes a prompt into `ollama run <model>` with a timeout and boolean result.
- Startup model discovery (`src/main/modelDiscovery.ts`, called from `composition.ts`) uses `OllamaCliRunner.listModels()` and `showModelContext()` for local endpoints, and preserves API discovery for configured remote endpoints.
- Max-turns signaling: tracks `exitReason` (`'natural' | 'context-ceiling' | 'max-turns'`) in the agent loop. Sets `isMaxTurns: exitReason === 'max-turns'` on the `done` StreamEvent. Natural completion (no tool calls) and context-ceiling exits do NOT set `isMaxTurns`.
- Phantom empty turn detection (added 2026-07-23): a turn with 0 content text AND 0 tool calls is a phantom (the Ollama server returned a 0-token `done` chunk — model OOM, GPU throw, etc.). The agent loop emits a `warning` event and retries the same turn index via `turn--; continue` up to `MAX_CONSECUTIVE_EMPTY_TURNS = 3` times. Exceeding the bound sets `exitReason = 'max-turns'` so the `done` event carries `isMaxTurns: true` — the outer `AutoTurnResumer` can react. Natural finish (content > 0) is unchanged.

### llama-server/ — llama-server HTTP Provider

| File | Purpose |
|------|---------|
| `LlamaServerClient.ts` | Implements `IModelProvider`. Uses OpenAI-compatible `/v1/chat/completions` with SSE streaming and function-calling tool use. Shares `ToolExecutor`, `OLLAMA_TOOLS`, and `WebSearcher` from `ollama-cli/`. |
| `index.ts` | Barrel export |

Key behavior:
- Exposes `providerId` as `'llama-server'` and capabilities: `text-completion`, `streaming`, `tool-use`
- Uses a custom undici dispatcher (`bodyTimeout: 0`, `headersTimeout: 0`) so long-running local models don't time out
- Tool calls dispatched through the shared `ToolExecutor` (same sandboxed Read/Write/Edit/LS/Bash/WebSearch as Ollama)
- Parses `<think>...</think>` tags in model content for reasoning-model support (QwQ, DeepSeek-R1, etc.)
- `isAvailable()` probes the configured base URL `/v1/models` endpoint
- `abortStream()` signals the `AbortController` backing the active `fetch` SSE connection
- Max-turns signaling: same `exitReason` pattern as Ollama — sets `isMaxTurns: exitReason === 'max-turns'` on the `done` StreamEvent when the agent loop exhausts all turns

### providers/ — Model Provider Registry

| File | Purpose |
|------|---------|
| `ProviderRegistry.ts` | Implements `IProviderRegistry`. Central hub for all model providers — registration, model routing (reverse index), config CRUD, persistence to settings. Protects built-in providers from deletion. |
| `OpenAiCompatibleProvider.ts` | Implements `IModelProvider` for OpenAI Chat Completions-compatible APIs. SSE streaming via `fetch`, `AbortController` cancellation, estimated token counts. No tool-use. Runtime `updateApiKey()`/`updateBaseUrl()`. |
| `index.ts` | Barrel export |

Key behavior:
- Constructor takes `ISettingsService` for config persistence
- `registerProvider()` adds provider + config, first registered becomes default
- `getProviderForModel()` uses reverse model→provider index (O(1) lookup)
- `resolveModelSelection()` repairs stale model IDs by choosing the requested model when available, then the active provider default, default provider default, or first enabled model
- `sendMessage()` routes to the resolved provider and emits a warning before using a fallback model
- `abortStream()` broadcasts to all providers (idempotent)
- `updateProviderConfig()` protects `id`, `type`, `isBuiltIn` from mutation
- Config changes auto-persist to `settings.json`

### pandoc/ — Export Engine

| File | Purpose |
|------|---------|
| `index.ts` | `resolvePandocPath(resourcesPath)` — resolves Pandoc binary path based on platform and packaged vs dev mode. |

### series/ — Series Management

| File | Purpose |
|------|---------|
| `SeriesService.ts` | Implements `ISeriesService`. File-based storage in `{userData}/series/{slug}/`. Manages `series.json` manifests and `series-bible.md` files. In-memory reverse-lookup cache (`bookSlug → seriesSlug`) rebuilt on mutation or explicit invalidation. |
| `index.ts` | Barrel export |

Key behavior:
- Constructor takes `userDataDir: string`, creates `series/` root if missing
- CRUD operations read/write `series.json` in each series directory
- Volume management auto-renumbers on add/remove/reorder
- Validates books aren't in multiple series simultaneously
- `getSeriesForBook()` uses lazy-built reverse cache for O(1) lookups
- `invalidateCache()` called by BooksDirWatcher when books directory changes
- `totalWordCount` in summaries is always 0 (renderer computes from bookStore)

---

## Schema

### `conversations`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PK | nanoid or UUID |
| `book_slug` | TEXT | NOT NULL | Directory slug |
| `agent_name` | TEXT | NOT NULL | From AgentName |
| `pipeline_phase` | TEXT | | Nullable for ad-hoc |
| `purpose` | TEXT | NOT NULL DEFAULT 'pipeline' | ConversationPurpose |
| `title` | TEXT | NOT NULL DEFAULT '' | From first user message |
| `created_at` | TEXT | NOT NULL | ISO 8601, defaults to datetime('now') |
| `updated_at` | TEXT | NOT NULL | ISO 8601, defaults to datetime('now') |

Index: `idx_conversations_book_slug` on `book_slug`

### `messages`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PK | nanoid or UUID |
| `conversation_id` | TEXT | NOT NULL, FK → conversations(id) ON DELETE CASCADE | |
| `role` | TEXT | NOT NULL, CHECK('user','assistant') | |
| `content` | TEXT | NOT NULL | Message body |
| `thinking` | TEXT | NOT NULL DEFAULT '' | Extended thinking content |
| `timestamp` | TEXT | NOT NULL | ISO 8601 |

Index: `idx_messages_conversation_id` on `conversation_id`

### `token_usage`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `conversation_id` | TEXT | NOT NULL, FK → conversations(id) ON DELETE CASCADE | |
| `input_tokens` | INTEGER | NOT NULL DEFAULT 0 | |
| `output_tokens` | INTEGER | NOT NULL DEFAULT 0 | |
| `thinking_tokens` | INTEGER | NOT NULL DEFAULT 0 | |
| `cache_read_tokens` | INTEGER | NOT NULL DEFAULT 0 | Prompt-cache reads (v4) |
| `cache_write_tokens` | INTEGER | NOT NULL DEFAULT 0 | Prompt-cache writes (v4) |
| `cost_usd` | REAL | nullable | Provider-reported cost of the call; NULL = not reported, estimated from `MODEL_PRICING` (v4) |
| `model` | TEXT | NOT NULL | Model used |
| `timestamp` | TEXT | NOT NULL | ISO 8601 |

`input_tokens` is uncached input only. Index: `idx_token_usage_conversation_id` on `conversation_id`

Migration: v4 in `migrations.ts` adds the three cache/cost columns through `Migration.apply` (each `ALTER TABLE` runs only when the column is missing; a missing table is skipped).

### `stream_events`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `session_id` | TEXT | NOT NULL | Groups events per CLI call |
| `conversation_id` | TEXT | NOT NULL | |
| `sequence_number` | INTEGER | NOT NULL | Ordering within session |
| `event_type` | TEXT | NOT NULL | StreamEvent.type discriminator |
| `payload` | TEXT | NOT NULL | JSON-serialized StreamEvent |
| `timestamp` | TEXT | NOT NULL | ISO 8601 |

Index: `idx_stream_events_session` on `(session_id, sequence_number)`

### `stream_sessions`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PK | nanoid |
| `conversation_id` | TEXT | NOT NULL | |
| `agent_name` | TEXT | NOT NULL | |
| `model` | TEXT | NOT NULL | |
| `book_slug` | TEXT | NOT NULL | |
| `started_at` | TEXT | NOT NULL | ISO 8601 |
| `ended_at` | TEXT | | NULL = still running or orphaned |
| `final_stage` | TEXT | NOT NULL DEFAULT 'idle' | ProgressStage |
| `files_touched` | TEXT | NOT NULL DEFAULT '{}' | JSON FileTouchMap |
| `interrupted` | INTEGER | NOT NULL DEFAULT 0 | 1 = marked as orphaned |

Index: `idx_stream_sessions_active` on `ended_at` WHERE `ended_at IS NULL`

### `file_versions`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | INTEGER | PK AUTOINCREMENT | Sequential version ordering |
| `book_slug` | TEXT | NOT NULL | Book directory slug |
| `file_path` | TEXT | NOT NULL | Relative to book root, `/` separators on every platform (v5) |
| `content` | TEXT | NOT NULL | Full file content snapshot |
| `content_hash` | TEXT | NOT NULL | SHA-256 hex digest for dedup |
| `byte_size` | INTEGER | NOT NULL | Content length in bytes |
| `source` | TEXT | NOT NULL CHECK(IN 'user','agent','revert') | Who caused this version |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | ISO 8601 |

Indexes:
- `idx_file_versions_lookup` on `(book_slug, file_path, id DESC)` — primary query pattern
- `idx_file_versions_hash` on `(book_slug, file_path, content_hash)` — dedup lookups

Migration: v2 in `migrations.ts` creates the table. v5 rewrites `\` to `/` in `file_path` (Windows builds stored watcher and file-tree paths with `\`). Row ids are kept, so the two forms merge into one history per file in write order. The table is skipped if missing.

---

## Claude CLI Integration

### Invocation

```
claude --output-format stream-json \
       --max-turns <maxTurns> \
       --model <model> \
       --system-prompt <systemPrompt> \
       [--thinking-budget <budget>] \
       -p <userMessage>
```

- Working directory set to book path (enables tool file operations)
- `--allowedTools` from `buildClaudeCliAllowedTools()` (`src/domain/constants.ts`): `Read(…)`, `Write(…)`, `Edit(…)` for `//<booksDir>/**` and each extra scope; `LS,Glob,Grep,WebSearch,Task,TodoWrite`; `WebFetch` when `allowWebFetch` is on; `Bash(<cmd>:*)` for each of `mkdir cat mv cp ls find grep wc head tail rm rmdir`. Rule paths use the CLI's absolute form (`//…`)
- `--setting-sources user`: the CLI ignores project settings in the book folder (including hooks)
- `--resume <cliSessionId>` when `AutoTurnResumer` continues a max-turns session
- Process spawned via `child_process.spawn`

### Streaming Protocol

CLI outputs NDJSON (one JSON object per line) to stdout. Events map to `StreamEvent`:

| CLI Event | StreamEvent Type |
|-----------|-----------------|
| `content_block_start` (type=thinking) | `blockStart` → `thinkingDelta` |
| `content_block_delta` (type=thinking_delta) | `thinkingDelta` |
| `content_block_start` (type=text) | `blockStart` → `textDelta` |
| `content_block_delta` (type=text_delta) | `textDelta` |
| `content_block_stop` | `blockEnd` |
| `content_block_start` (type=tool_use) | `toolUse` |
| `content_block_start` (type=tool_result) | `toolUse` (status update) |
| `result` | `done` (with token counts) |

### Orphan Recovery

On startup, `ChatService.recoverOrphanedSessions()` checks `stream_sessions` for rows with `ended_at IS NULL`, marks them as `interrupted`, and exposes them to the UI.

---

## File Watchers

### BookWatcher

- Watches: single book directory (switchable via `watch(slug)`)
- Events: file change/add/delete within the book. Paths are book-relative with `/` (Windows `fs.watch` names are converted)
- Consumer: `chat:filesChanged` IPC event → renderer; also `VersionService.snapshotFile(activeSlug, path, 'agent')` in `src/main/composition.ts`
- Debounced to avoid flooding during rapid writes

### BooksDirWatcher

- Watches: `books/` root directory
- Events: folder added or removed
- Consumer: `books:changed` IPC event → renderer bookStore reload
- Started once at app init via `start()`
