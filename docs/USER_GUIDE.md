# Novel Engine Spur — User Guide

*Novel Engine Spur is a fork of Novel Engine by John Paul Ruf.*

> Last updated: 2026-11-25

---

## 1. What is Novel Engine Spur?

Novel Engine Spur is a desktop app for writing novels with a team of AI agents. Each agent has one job in the writing process, from pitching a story through drafting, revision, copy editing, publication and querying.

The agents run through an AI command-line tool on your computer. The main one is the **Claude CLI** (Claude Code), which signs in with your own Anthropic account. Novel Engine Spur doesn't store API keys or handle billing. It can also use the Codex CLI, Ollama, llama-server or an OpenAI-compatible server (see **Settings → Providers**).

Your books, chats and files stay on your computer, in the app's data folder. The only things sent out are the agents' calls to the AI service, plus any web searches and pages the agents open (see **Web Access** in section 15).

---

## 2. Getting Started

### First Launch

The first time you open the app, a setup wizard walks you through:

1. **Welcome**: click **Get Started**.
2. **Connect an AI backend**: install and sign in to at least one CLI. For Claude: `npm install -g @anthropic-ai/claude-code`, then run `claude` in a terminal and sign in. Click **Check Providers**, or **Skip for now** and set it up later in Settings.
3. **Choose Your Model**: pick the default model. **Claude Opus (latest)** is recommended for creative work.
4. **Tell Us About Your Writing**: your author name and, optionally, a few lines about what you write. This starts your author profile.
5. **You're All Set!**: optionally type a title for your first book, then click **Launch Novel Engine Spur**.

If you used the original Novel Engine on this computer, the app first asks what to do with that data. See **Data Folder** in section 15.

### Finding Your Way Around

- **Icon rail** (left edge). Top: **Library**, **Workspace**, **Manuscript**, **Exports**, **Query Manager**. Bottom: **Help** (the lightbulb), **Statistics**, **Settings**. Workspace, Manuscript, Exports and Query Manager need a book selected.
- **Title bar**: shows where you are. The **Search** pill opens the command palette.
- **Command palette** (`Ctrl+K`, or `⌘K` on macOS): jump to any view, book, pipeline phase or chapter, or run an action such as New Book, Import, Hot Take, Find & Replace, Pitch an idea with Spark or Export as EPUB.
- **Status bar** (bottom): the agent that's working, its model (for example "Opus 5.5"), the tool it's using and the file it's on, plus a token count. The button at the right opens the **activity drawer**, which shows each agent call in detail and lets you stop one.
- **Help** opens the Help & FAQ assistant, which answers questions about the app.

### Guided Tours

**Settings → Profile → Guided Tours** has three short tours: **Welcome Tour**, **First Book Guide** and **Pipeline Deep Dive**.

### The Author Profile

The author profile describes your voice, themes, genres and style. Spark, Verity and Quill read it in every chat. It's one file shared by all your books.

Edit it in **Settings → Profile → Author Profile**. **Set Up with Verity** (or **Refine with Verity**) builds it through a short interview. **Edit Manually** opens it as text.

---

## 3. The Library

The **Library** is your bookshelf. It shows each book's cover, title, pipeline position ("Phase 6 of 15") and word count. Books in a series are grouped under the series name.

- **Open a book**: click its card. The app makes it the active book and opens the Workspace.
- **New Book**: the dashed **New Book** card, or **New Book** in the command palette. Enter a title and click **Create**. The folder name comes from the title. A title that matches an existing book, archived books included, is refused, even if it differs only in capitals or punctuation. Choose another title.
- **Change a cover**: click the cover image and pick a picture.
- **Book actions** (the `⋯` button on a card): **Book info** shows the book's `about.json` details (title, author, status, genre and the other fields Spark fills in). **Archive** moves the book off the shelf.
- **Archived**: lists archived books. **Restore** puts one back.
- **Manage series**: create and edit series (section 12).
- **Pitch an idea with Spark**: opens the Pitch Room (section 11).

### Importing

Click **Import** in the Library (or **Import…** in the palette) and choose:

- **Single Book**: a manuscript file (`.md`, `.markdown` or `.docx`). The app finds chapter breaks and shows a preview. Rename, merge or remove chapters, set the title and author, then click **Import**. Afterwards, **Generate Source Documents** has the agents write a pitch, scene outline and story bible, voice profile and motif ledger from your chapters. Each step reads the whole manuscript and can take several minutes. Or click **Open Book** and skip it.
- **Series**: several manuscripts at once, as the volumes of a new series. Any volume whose title is already taken must be renamed first.
- **From another Novel Engine folder…**: copies books from another data folder, such as an old install, a copy from another computer, or a backup. Each book shows its word count, chats and history size. Chosen books come with their chats, token usage, version history and word-count history. The other folder is only read, never changed. A book whose title clashes can be renamed or skipped. You can also copy the series those books belong to, and the author profile (only if yours is still empty). Agent prompts and settings are never copied.

An imported book's pipeline starts at the first phase whose files are missing. Use **Mark done** to skip phases you don't need (section 4).

---

## 4. The Writing Pipeline

The pipeline is 15 phases that take a book from idea to querying. Each phase has an agent and output files. Phases unlock in order.

| # | Phase | Agent | Done when |
|---|-------|-------|-----------|
| 1 | **Story Pitch** | Spark | `source/pitch.md` is written |
| 2 | **Story Scaffold** | Verity | `source/scene-outline.md` is written (Verity also writes `source/story-bible.md`) |
| 3 | **First Draft** | Verity | You mark it done once the chapters are written |
| 4 | **First Read** | Ghostlight | `source/reader-report.md` is written |
| 5 | **Structural Assessment** | Lumen | `source/dev-report.md` is written |
| 6 | **Revision Plan** | Forge | `source/project-tasks.md` and `source/revision-prompts.md` are written |
| 7 | **Revision** | Verity | You click **Complete Revision** |
| 8 | **Second Read** | Ghostlight | A new `source/reader-report.md` is written |
| 9 | **Second Assessment** | Lumen | A new `source/dev-report.md` is written |
| 10 | **Copy Edit** | Sable | `source/audit-report.md` is written (Sable also keeps `source/style-sheet.md`) |
| 11 | **Fix Planning** | Forge | A new task list and session prompts are written |
| 12 | **Mechanical Fixes** | Verity | You mark it done once the fixes are in |
| 13 | **Build** | (none) | The Exports view builds the book |
| 14 | **Publish & Audit** | Quill | `source/metadata.md` is written |
| 15 | **Query Agents** | Quill | `source/query-tracker.md` has your targets |

The spine on the left of the Workspace groups the phases into five stages: **Conceive**, **Draft**, **Assess**, **Revise** and **Ship**.

### Phase States

- **Locked**: an earlier phase isn't done yet. Selecting it shows "Unlocks after …".
- **Active**: the phase you're working on.
- **Agent finished**: the output files exist. Nothing moves on until you review them and click **Confirm & advance**. This is your quality gate.
- **Complete**: confirmed. Its conversation is read-only.

### Phase Controls

These appear in the phase header and on the spine's current-phase card:

- **Primary action**: each phase has one, such as **Start First Read**, **Build Revision Plan** or **Run Audit**. It opens the phase's conversation. On Build it opens the Exports view. On Publish & Audit it builds the book first if there's no build yet.
- **Confirm & advance**: shown when the agent has finished.
- **Mark done**: marks the current phase complete without its agent, for work done elsewhere or a phase you want to skip. Click twice to confirm. First Draft, and usually Mechanical Fixes, are finished this way, because they have no single output file.
- **← Revert here**: on a completed phase. Moves the pipeline back to that phase; it and every later phase need confirming again. Click twice to confirm. Files aren't deleted, so a reverted phase whose files exist shows as finished and needs **Confirm & advance** again.
- **Complete Revision** (Revision phase only): saves copies of the reader report, the dev report and the revision plan, then moves on to Second Read. Click twice to confirm.

### Auto Draft (First Draft)

**Start Auto Draft** has Verity write the draft chapter by chapter, following the scene outline. After each chapter, the secondary model (section 15) audits it, and Verity runs a fix pass when the audit finds moderate or heavy problems. Every three chapters, Lumen updates the motif ledger. **Stop Auto Draft** (click twice) stops it. If a call fails, the run pauses and **Retry Auto Draft** resumes it. When the draft is complete, review it and click **Mark done**.

### Earlier Reports Are Kept

When Ghostlight, Lumen, Sable or Forge starts a new pipeline run, the app first saves the previous output under the next free number: `reader-report-v1.md`, `reader-report-v2.md` and so on (also `dev-report-vN.md`, `project-tasks-vN.md`, `revision-prompts-vN.md` and `session-handoffs-vN/`). **Complete Revision** does the same. The file without a number is always the newest. Saved versions are never deleted. Agents don't rename or move reports; the app does it.

---

## 5. The Workspace

The Workspace is where you work with the agents. It has three parts: the pipeline spine on the left, the phase header across the top, and below it the chat on the left and the companion pane on the right. Drag the divider to resize them.

### The Phase Header

- The phase name, its agent and the agent's role.
- **File chips** for the phase's output files. A tick means the file exists; click it to open it in the companion pane.
- **Quick chips**, depending on the stage: **Hot Take** (after the draft), **Ad Hoc Revisions** (Revise stage) and **Set Up Voice Profile** (Draft stage, when there's no voice profile yet).
- The phase controls from section 4.

### Chatting

- **Phase starter card**: a phase with no messages yet shows its description and **Common starting points**. Click one to put that prompt in the message box, edit it if you like, and send. **Start a blank conversation** opens an empty chat. The card goes away once you send the first message.
- **Conversations**: the dropdown at the top of the chat switches between this phase's conversations. **New conversation** starts another. Phase conversations can't be deleted in this version.
- **Quick actions ▾**: built-in prompts for the agent, and a **Saved** tab where you keep your own prompts (name, paste, save).
- **Thinking**: the **Thinking** control next to the input sets how much the agent reasons before answering, for this message.
- Press **Enter** to send and **Shift+Enter** for a new line.
- **Long reads run in steps.** Choosing one of the full-pass actions (Read the manuscript, Full assessment, Copy edit, Create revision plan, Plan copy fixes) as the first message in a pipeline conversation with Ghostlight, Lumen, Sable or Forge runs as a series of smaller calls: read the manuscript in batches, then write the report. Text you add after the action's prompt goes to every step as a note from you. Any other first message (Plan from my feedback, Pacing & scenes, Character arcs, Build style sheet, or anything you type) is ordinary chat, and the agent sees your text. Later messages are ordinary chat too.
- **Stopping an agent**: open the activity drawer (status bar) and stop the call there.
- If the app closed while an agent was working, a bar says the previous session was interrupted. Check what the agent finished, then ask it to continue.

### The Companion Pane

Tabs beside the chat:

- **Chapter**: read a chapter as it's being written. Pick it from the chapter list.
- **Sources**: Pitch, Scene Outline, Story Bible and Voice Profile.
- **Reports**: the reports and plans from Ghostlight, Lumen, Sable and Forge. For the newest version of a report, use the file without a `-vN` number. Earlier versions are also in the Explorer.
- **Motifs**: the motif ledger (section 13).
- **Explorer**: browse every file in the book folder. Text files (Markdown, JSON, YAML, plain text) open as a preview, with **History**, and **Edit**, which opens the file in the Manuscript editor. Images and other non-text files show only their name, type and size; they can't be opened or edited in the app, which keeps them from being damaged. Chapter drafts are edited from the Manuscript view.

---

## 6. The Agents

| Agent | Role | Works on |
|-------|------|----------|
| **Spark** | Story Pitch | Pitch, book details in `about.json` (genre, audience, comp titles) |
| **Verity** | Ghostwriter | Scene outline, story bible, voice profile, every chapter, revisions and fixes |
| **Ghostlight** | First Reader | Cold reads and hot takes |
| **Lumen** | Developmental Editor | Structural assessments, chapter deep dives, motif audits |
| **Sable** | Copy Editor | Copy edit audit, style sheet |
| **Forge** | Task Master | Revision plans and session prompts for Verity |
| **Quill** | Publisher | Publication metadata, synopses, query letters, query research |
| **Helper** | Help & FAQ | Questions about the app (the lightbulb on the rail) |

Wrangler works in the background (it reads Forge's plan into revision queue sessions). You don't chat with it.

**Spark** asks what you're drawn to and writes a pitch card. Quick actions: *Pitch me a story*, *I have an idea...*, *Revisit the pitch*.

**Verity** writes the outline, story bible and chapters, and makes the revisions the other agents plan. Quick actions: *Next chapter*, *Build scene outline*, *Build story bible*, *Revise chapter...*.

**Ghostlight** reads like a reader who has never seen your notes. It doesn't read the pitch, outline, story bible, author profile, chapter notes or series bible. It reads the voice profile only after the read, and ends its report with a short "Intent vs. experience" section comparing what you meant with how it read. Quick actions: *Read the manuscript*, *Hot Take*.

**Lumen** analyzes structure through seven lenses: premise, protagonist arc, supporting cast, pacing, scene necessity, prose and craft, theme. Quick actions: *Full assessment*, *Pacing & scenes*, *Character arcs*.

**Sable** audits grammar, consistency and formatting, and keeps the style sheet. Quick actions: *Copy edit*, *Build style sheet*.

**Forge** turns the reports into a phased task list and session prompts for Verity. Quick actions: *Create revision plan*, *Plan copy fixes*, *Plan from my feedback*.

**Quill** prepares the book for publication and querying. Quick actions include *Prepare for publication*, *Generate metadata*, *Query Letter (Traditional)*, *Synopsis (Traditional)*, *Analyze for queries* and *Find agents for this book*.

### Extra Agent Actions

- **Hot Take** (Ghostlight): a quick gut reaction to the whole manuscript, written in the chat. From the phase header chip or the palette.
- **Deep Dive (Lumen)**: a focused analysis of one chapter. From a chapter's menu in the Manuscript view.
- **Set Up Voice Profile** (Verity): an interview that writes `source/voice-profile.md`. From the phase header chip in the Draft stage or the palette.

### What the Agents Can Reach

Agents can read and write files only in the `books` folder, the `series` folder and the author profile. They can search the web. They can also open web pages unless you turn that off in **Settings → Writing → Web Access**.

---

## 7. The Manuscript View

The Manuscript view is for reading and editing the book.

- **Reader / Editor**: switch between reading and editing.
- **Chapter / Full book** (Reader): one chapter, or the whole book in one scroll. **Read full manuscript** in the palette goes straight there.
- **Chapter list**: front matter (Copyright, Dedication), story chapters, then back matter. Each chapter's menu (`▾`) has **Notes** (opens or creates that chapter's `notes.md`), **Deep Dive (Lumen)** and **Delete**. You can add back-matter chapters at the bottom of the list.
- **Editing Verity's chapters**: you can edit Verity's drafts directly. A bar says "You're editing Verity's draft". Every change is tracked and shown to Verity on her next revision. **View my changes** shows your edits and can discard them. While an agent is working on the book, editing is paused.
- If a file changes on disk while you're editing it, a bar offers **Reload** or **Keep mine**.
- **Version history** and **Find & Replace** buttons are at the top.

### Find & Replace

Search the whole manuscript, with case-sensitive and regular-expression options. **Preview** lists every match by chapter. Untick the chapters to leave alone, then click **Replace in N chapters**. Leave the replacement empty to delete the matches. Only text files are changed.

### Reading Comfort

- **Font size**: `Ctrl` + mouse wheel, or `Ctrl` + `=` / `-` (`⌘` on macOS). `Ctrl` + `0` resets it. This applies to all typeset prose: the Chapter, Sources, Reports and Explorer tabs and the Manuscript reader.
- **Reading font, size and line numbers**: **Settings → Appearance → Reading** (section 15).

---

## 8. The Revision Queue

The Revision Queue runs Forge's plan through Verity, one session at a time.

### Opening It

- In the **Revision** and **Mechanical Fixes** phases, once Forge has written the plan, the primary action is **Open Revision Queue**.
- In any Revise-stage phase, the **Ad Hoc Revisions** chip (also in the palette) opens it. Use it with Forge's *Plan from my feedback* to run your own revision requests.

The queue loads the plan from `source/project-tasks.md` and `source/revision-prompts.md` when it opens. **↻ Clear Cache** reloads it after Forge changes the plan.

### Running Sessions

- **▶ Run Next** runs one session. **▶▶ Run All** runs every pending session. **Pause** stops after the current one.
- **Modes**:
  - **Manual**: the queue pauses every time Verity stops.
  - **Auto-Approve**: sessions run back to back, and yes/no stops ("Shall I proceed?") are approved for you. Questions with options still pause.
  - **Auto-Skip**: like Auto-Approve, but yes/no stops are answered with "skip this task". Questions with options still pause.
  - **Selective**: choose which sessions to run.
- **Verify**: when the sessions are done, opens a chat in which Verity checks that every revision is in.

### Approval Gates

A session finishes only when Verity says every task is done. When she stops for any other reason, the queue pauses and shows a gate bar:

- **Approve**: let her continue with the next task.
- **Approve All**: approve this and the session's later yes/no stops. Questions with options still pause.
- **Mark Complete**: Verity is done; close the session without another call.
- **Skip**: tell her to skip the current task.
- **Type an answer**: send your own reply. When Verity asks you to choose ("A or B?"), Approve and Approve All are hidden and typing an answer is the way forward.

### The Panel

The queue opens as a panel over the app. Drag its left edge to make it wider; double-click the edge to reset it. While sessions are running, closing the panel minimizes it instead.

---

## 9. Exports

Open **Exports** on the rail.

1. Click **Build manuscript**. The app joins all chapters in order and runs Pandoc. Progress shows as it goes.
2. The build writes `dist/<book>.md` (Markdown), `dist/<book>.docx` (Word) and `dist/<book>.epub` (EPUB, with your cover). PDF is listed but isn't built in this version; make a PDF from the Word file if you need one.
3. Click an output to open it, open the `dist` folder, or **Download All** to save a ZIP.

Word and EPUB need **Pandoc**. The app bundles it where it can. If it's missing, the Exports view says so and links to pandoc.org.

---

## 10. Publishing and Querying

**Publish & Audit** (Quill) audits the build and writes publication metadata (title, subtitle, description, keywords, categories, comp titles, back-cover copy) to `source/metadata.md`.

**Query Agents** (Quill) and the **Query Manager** view help you query agents and publishers:

- **Research Targets**: Quill finds literary agents, publishers or platforms that fit the book.
- **+ Add Target**: add one yourself (name, type, contact, method, link, personalization notes, notes).
- Each target card has **Generate Letter** (a personalized query letter, saved in `source/query-letters/`) and a **Status**: Drafting, Queried, Partial Request, Full Request, Offer, Rejected or Withdrawn.
- Filter by method, status and type.

Targets are saved in `source/query-tracker.md`.

---

## 11. The Pitch Room

The Pitch Room is free brainstorming with Spark, separate from any book. Open it from the Library's **Pitch an idea with Spark** card, or from the palette (**Pitch Room**, **New Pitch**).

- **New Pitch** starts a session. Sessions are listed on the left and can be deleted.
- When Spark has written a pitch, **Promote to Book →** creates a new book with that pitch in place. If the title is taken, you're asked for another.
- **Shelved pitches** are pitches saved for later. **Shelve Current Pitch** saves a copy of the active book's pitch to the shelf. Each shelved pitch has **Preview**, **Restore** (creates a new book from it) and **Delete**.

---

## 12. Series

Click **Manage series** in the Library (or **Manage** next to a series name on the shelf).

- **Create New Series**: a name and an optional description.
- **Volumes**: **Add Book** adds one of your books. **Move up** and **Move down** change the order. **Remove from series** takes a book out. Volume numbers follow the order.
- **Series Bible**: a shared document for the whole series: world rules, character registry, timeline, continuity notes. Edit it in the series view and click **Save Bible**.
- **Archive Series** is in the series view. **Delete series** is in the series list.

Every agent working on a book in the series can read the series bible, except Ghostlight. A cold reader shouldn't know the author's notes, so Ghostlight reads a sequel as a new reader would.

Series are stored in the data folder under `series/<series>/` (`series.json` and `series-bible.md`), not inside a book.

---

## 13. The Motif Ledger

The motif ledger (`source/motif-ledger.json`) tracks the book's recurring patterns. Open it on the **Motifs** tab in the Workspace. Its tabs:

- **Systems**: recurring thematic patterns, such as light and darkness.
- **Entries**: specific phrases, images or symbols tied to characters.
- **Structural**: devices such as framing, callbacks and echoes.
- **Foreshadow**: planted setups and their payoffs.
- **Minor Chars**: motifs for the supporting cast.
- **Flagged**: overused or problem phrases.
- **Audit Log**: what each audit changed.

During Auto Draft, Lumen updates the ledger every three chapters. You can edit entries yourself. "Unsaved changes" shows until you click **Save** (or press `Ctrl+S`).

---

## 14. Version History

The app keeps versions of every Markdown and JSON file in a book. A version is saved when an agent writes a file, when you save one, and when you revert one.

Open the history from the **Version history** button in the Manuscript view or on the Chapter, Sources, Reports and Explorer tabs. Each version shows when it was made and by whom (**You**, **Agent** or **Revert**). You can compare two versions and revert to any of them. The newest 50 versions of each file are kept.

---

## 15. Settings

Open **Settings** at the bottom of the rail. There are four tabs.

### Writing

- **Model Selection**: the **Primary Model** runs every agent chat, the revision queue and hot takes. The **Secondary Model** runs lighter passes, such as Auto Draft's chapter audits. The Claude CLI offers **Claude Opus (latest)**, **Claude Sonnet (latest)** and **Claude Haiku (latest)**; "latest" means the CLI picks Anthropic's current model of that family. Other providers' models are listed by provider.
- **Check for Fable access** (shown when Fable isn't listed): sends one short request to see whether your account can use Claude Fable. On some plans this uses paid credits.
- **Extended Thinking**: **Show agent thinking** turns thinking on. **Override per-agent thinking budgets** sets one budget for all agents. **Auto-collapse thinking after response** folds the thinking block away once the answer is in.
- **Web Access**: **Let agents open web pages**. Agents can always search the web; turn this off to stop them opening the pages they find. Applies from the next agent call.

### Providers

- **Built-in CLI Status**: shows whether the Claude, Codex and Ollama CLIs are connected. **Re-check** tests again.
- **Claude CLI updates**: **Offer to check for Claude CLI updates at launch (at most weekly)**, and **Check for updates now**, which runs `claude update`.
- **Model Providers**: the built-in providers and any OpenAI-compatible servers you add (**Add OpenAI-Compatible Provider**). **Test Connection** checks one; **Use as Active** switches to it.

### Appearance

- **Appearance**: **Dark** (default), **Light** or **System**.
- **Reading**: the **Reading font** for typeset prose: Fraunces (default), Classic serif, Sans, Monospace, or **Custom (installed font)…** with the name of any font on your computer. A preview line shows it. **Prose font size** (A−, A+, Reset) does the same as `Ctrl` + wheel. **Show line numbers in chapter views** numbers each paragraph by its line in `draft.md`, the same numbers the agents see, so you can point Verity at a passage by line. Interface fonts don't change.
- **Notifications**: **Show OS notifications when agents finish**, for chat replies, builds and revision sessions that finish while the app is in the background.
- **About**: version, links to this fork and to the original Novel Engine.

### Profile

- **Author Profile**: author name and profile (section 2).
- **Guided Tours**.
- **Token Usage Summary**: tokens used, by type, and number of conversations.
- **Catalog Export**: **Export All Books to ZIP**, with every book's source files, chapters and builds.
- **Data Folder**: see below.
- **Agent Prompts**: see section 17.

### Data Folder

**Data Folder** shows where the app keeps your books, chats, agent prompts and settings. **Open Folder** opens it. **Change…** picks another folder and **Use Default Folder** goes back. Both restart the app.

Changing the folder doesn't copy or move anything. To take your data along, close the app, copy the whole folder, then start the app and choose the copy. If the chosen folder already holds Novel Engine Spur data, the app uses it. If it's empty, the app starts fresh.

If you used the original Novel Engine, its data is in a folder named `Novel Engine` next to Spur's own. On first launch Spur offers:

- **Copy** (recommended): Spur gets its own copy of your books and history, and the original app keeps working with its folder. Close Novel Engine before copying.
- **Use in place**: both apps share one folder, one database and one set of agent prompts.
- **Start fresh**: begin with no books. You can switch later with **Change…**.

Only one copy of the app can use a data folder at a time. If you start a second copy on the same folder, it says the folder is already in use and offers **Use another folder…** or **Quit**. (The original Novel Engine doesn't check this, so don't run both on one folder at once. Network and virtual-machine shared folders may not support the check.)

Advanced: start the app with `--data-dir=/absolute/path`, or set the `NOVEL_ENGINE_DATA_DIR` environment variable, to use another folder for that run. While either is set, the folder can't be changed in Settings.

---

## 16. Statistics

Open **Statistics** on the rail. Choose one book or **All Books**. It shows:

- **Total Tokens**, including how many were cached. Most of an agent's input is cached, which is cheaper.
- **Conversations**, **Estimated Cost** (at API rates) and **Total Words**.
- Charts: **Token Usage Over Time**, **Usage by Agent**, **Usage by Phase**, **Word Count History** and **Words Per Chapter**.

The cost is the Claude CLI's own figure where it reports one, and an estimate otherwise. If you're on a subscription, it's what the same work would cost at API rates, not what you pay.

---

## 17. Files and Folders (for Power Users)

### The Data Folder

By default:

- **Windows:** `%APPDATA%\Novel Engine Spur\`
- **macOS:** `~/Library/Application Support/Novel Engine Spur/`
- **Linux:** `~/.config/Novel Engine Spur/`

It holds:

```
books/                  # One folder per book
  _archived/            # Archived books
  _pitches/             # Shelved pitches
series/                 # Series: series.json and series-bible.md per series
custom-agents/          # Agent prompts (editable)
author-profile.md       # Your author profile
novel-engine.db         # Chats, token usage, version history
settings.json           # App settings
backups/                # Database copies taken before upgrades
USER_GUIDE.md           # This guide (replaced on every launch)
instance.lock           # Held while the app is running
```

There are also a few small files the app manages itself, such as `active-book.json` and `instance.lock.json`.

### A Book's Folder

```
books/my-novel/
  about.json              # Title, author, status, cover, plus Spark's genre and comp details
  source/
    pitch.md              # Spark
    scene-outline.md      # Verity
    story-bible.md        # Verity
    voice-profile.md      # Verity
    reader-report.md      # Ghostlight (earlier reads: reader-report-v1.md, -v2…)
    dev-report.md         # Lumen (earlier: dev-report-vN.md)
    project-tasks.md      # Forge
    revision-prompts.md   # Forge
    audit-report.md       # Sable
    style-sheet.md        # Sable
    metadata.md           # Quill
    query-tracker.md      # Query Manager targets
    query-letters/        # One letter per target
    motif-ledger.json     # Motif ledger
  chapters/
    00-0-copyright/draft.md
    00-1-dedication/draft.md
    01-the-beginning/
      draft.md            # Chapter prose
      notes.md            # Your notes on the chapter (optional)
    z01-afterword/        # Back matter
  assets/                 # Images and other files
  dist/                   # Build outputs
```

Agents keep working notes in `source/.scratch/` while a long read is running.

### Customizing Agent Prompts

The agents' prompts are the `.md` files in `custom-agents/`. You can edit them. Most prompts are read once per launch, so restart the app after an edit.

When you install a new version, prompts you haven't edited are updated to the new version. Prompts you have edited are left alone and listed under **Settings → Profile → Agent Prompts**. To get the new version of an edited prompt, merge the changes by hand, or delete your copy and restart the app. **Open Prompts Folder** opens `custom-agents/`.

### Database Backups

Before an upgrade changes the database, the app saves a copy in `backups/` (the newest three are kept). If it can't make the copy, it stops before changing anything and shows an error.

### The Author Profile and Series Bible

Both live in the data folder, outside any book. The author profile is shared by all books. A series bible is shared by the books in that series.

---

## 18. Keyboard Shortcuts and Tips

| Keys | Does |
|------|------|
| `Ctrl+K` / `⌘K` | Command palette |
| `Esc` | Close the palette or a dialog |
| `Enter` / `Shift+Enter` | Send / new line in the chat |
| `Ctrl` + wheel, `Ctrl` + `=` / `-` | Prose font size |
| `Ctrl` + `0` | Reset prose font size |

Tips:

- **Read before you advance.** **Confirm & advance** is your quality gate.
- **Use chapter notes.** A chapter's `notes.md` is for you and for Verity, Lumen and Sable. Ghostlight never reads it.
- **Point at lines.** Turn on line numbers and tell Verity "lines 40–52 in chapter 3".
- **Hot Take** gives a quick gut check without a full read.
- **Follow the pipeline order.** Each phase builds on the ones before. Use **Mark done** for phases you really don't need.

---

## 19. Troubleshooting

### "Claude CLI not detected"

1. Install it: `npm install -g @anthropic-ai/claude-code`
2. Sign in: run `claude` in a terminal and follow the login steps.
3. Check it: `claude --version` shows the version.
4. In **Settings → Providers → Built-in CLI Status**, click **Re-check**, or restart the app.

### "This Claude CLI is too old for this model"

The model names (Opus, Sonnet, Haiku) always point at Anthropic's latest model, which may need a newer CLI. A banner says so and offers **Update Claude CLI**, which runs `claude update`. For a chat message it then offers to retry the message. The update can't run while an agent is working. If it fails, the banner shows the output and the command to run yourself.

### "This data folder is already in use"

Another copy of the app has the folder open. Close it, or choose **Use another folder…**. See section 15.

### An Agent Isn't Responding or Stops Early

- Check that the CLI is still signed in (run `claude` in a terminal).
- Check your internet connection.
- Open the activity drawer from the status bar to see what the agent is doing. You can stop a call there.
- Try another model in **Settings → Writing → Model Selection**.

### An Agent Says It Can't Read or Write a File

Agents can reach only the `books` and `series` folders and the author profile. Anything else in the data folder or elsewhere on your computer is refused.

### Slow Responses

- Opus is slower than Sonnet. A full manuscript read can take several minutes.
- Higher thinking budgets add time.
- Large manuscripts (100,000 words or more) take longer.

### Files Not Updating

The views refresh when agents write files. If one doesn't, switch tabs or views and back. Check the agent's reply for errors.

### Build Fails

- **Pandoc not found**: install it from https://pandoc.org/installing.html.
- **Missing chapters**: the build joins chapters in order. A chapter folder without a `draft.md` is left out.
- **Word or EPUB errors**: check the chapter Markdown.

### Reporting Bugs

Report bugs at **https://github.com/Foozinator/novel-engine/issues**. Include what you were doing, what you expected, what happened instead, and your operating system and app version (**Settings → Appearance → About**).
