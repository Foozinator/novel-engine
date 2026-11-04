Novel Engine hardcodes its Claude models in `BUILT_IN_PROVIDER_CONFIGS` (src/domain/constants.ts): `claude-opus-4-20250514` and `claude-sonnet-4-20250514`. A new Claude user starts on models several releases old, with no way to pick anything newer short of hand-editing settings.json. I did that to add Opus 5.5, and the first run failed with:

> API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.

My CLI was nearly a hundred versions behind, even though NE had been running it every day. `claude update` fixed it in seconds. I don't know why the native installer's auto-update never caught it; every NE call is a short `-p` process, which may be why. NE also showed the error as "Claude CLI run failed (success)", because the result event had subtype `success` with `is_error` set, so the label read as nonsense.

I want two changes, and they belong together.

First, use the CLI's model aliases. Ship `opus`, `sonnet` and `haiku` as the built-in Claude models instead of dated IDs. The CLI resolves each alias to Anthropic's current recommended version, so the list stops going stale. Keep the option to add a full model ID for anyone who wants to pin a version. On startup, if the saved claude-cli provider still lists only the old built-in IDs, add the aliases and move the primary and secondary models to `opus` and `sonnet`, leaving any IDs the user added alone. The Fable probe (`probeFableModel`) looks for `claude-fable-5`, but the current model is `claude-fable-5-1`, so it should probe the `fable` alias instead. Don't make `best` a default: it picks Fable wherever Fable is available, and Fable has its own weekly limit and, on some plans, paid usage credits.

Aliases also fix two smaller things. RevisionQueueService ignores Forge's opus/sonnet tier and always uses settings.model, because an unrecognized model ID made the CLI exit silently. Aliases are always recognized, so Forge's tiers could be honored again. And the stream's system init event reports the model an alias actually resolved to. NE ignores that event today. Showing it in the status bar would turn "opus" into "Opus 5.5", and the cost estimate, which applies the first pricing entry (Opus 4's) to every call, could use the right price.

Second, check for CLI updates. Aliases make this necessary, because an alias can move to a model the installed CLI can't run. That is exactly the error above.

When a run fails with "does not support this model; version X or newer is required", show that message plainly with an "Update Claude CLI" button that runs `claude update`, then offer to retry the call.

Also, on launch, at most once a week, run `claude --version` and offer to check for updates. `claude update` checks and installs in one step, so ask before running it, show its output, and read the version again afterward. Only run it when no CLI process is active; on Windows a running `claude.exe` blocks the update. If `claude update` can't update the install, as with some package-manager installs, show its output and the manual command. Let me turn the weekly reminder off in Settings.
