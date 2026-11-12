# Novel Engine — Project Memory

## Session Program Output Directory

When writing a session program (MASTER.md + STATE.md + SESSION-NN.md files), **always** write to:

```
prompts/session-program/program-NNN/
```

To determine NNN: `ls prompts/session-program/` → find the highest `program-NNN` → increment by 1. Start at `001` if none exist.

Source/input files that the program was built from go in:
```
prompts/session-program/program-NNN/input-files/
```

Internal path references inside MASTER.md must point to `prompts/session-program/program-NNN/STATE.md` and `prompts/session-program/program-NNN/SESSION-NN.md`.

**Never write programs to** `prompts/feature-requests/`, `prompts/feature/`, or any other path.

---

## FORGE-CONFIG.md

Project-level Forge configuration lives at `FORGE-CONFIG.md` (project root). Read it at the start of every Forge run. It contains the module registry, conventions, verification commands, and architecture rules for Novel Engine.

---

## AGENTS.MD (changelog and architecture docs)

@AGENTS.MD

---

## Fork conventions (Foozinator/novel-engine)

This repo is a fork of `john-paul-ruf/novel-engine`. Upstream is frozen: the maintainer stopped work on the app in November 2026. The fork is now the project, and its issues are the backlog.

### Ground rules

1. **Never write to upstream** (`john-paul-ruf/novel-engine`): no issues, PRs, comments, labels or reactions. Any message to the maintainer, including security disclosure, comes from the repo owner.
2. **Target the fork explicitly.** `gh issue create` and `gh pr create` in a fork clone default to the parent repo. Keep `gh repo set-default Foozinator/novel-engine`, pass `--repo Foozinator/novel-engine` on every `gh` write, and pass `--base main` on `gh pr create`.
3. **Ask before writing or deleting.** Show the exact text before any GitHub write, any `git push`, and any label or branch deletion, then wait for an OK.
4. **Keep security findings out of public places** (issues, PRs, commits, branch names). Other people still run the upstream app. Details go in `notes/security.md`, which is untracked; the owner handles disclosure.
5. **Keep manuscript text out of public issues and commits.** Test with throwaway books built from copies, never a live book folder.
6. **Use full upstream references** (`john-paul-ruf/novel-engine#N`). A bare `#N` means this fork, and fork-local refs like `Closes #12` are fine on fork PRs. Full upstream refs post a cross-reference on upstream, so ask first.
7. **Don't push `v*` tags.** They trigger `.github/workflows/release.yml`.
8. **Personal tooling stays untracked.** Use `.git/info/exclude`, not `.gitignore`.

### Branches and PRs

- Work on short-lived branches cut from `main`: `feat/<issue#>-<slug>`, `fix/<issue#>-<slug>`, `chore/<slug>`, `spike/<issue#>-<slug>`.
- Merge to `main` through a PR on the fork (`gh pr create --repo Foozinator/novel-engine --base main`). PRs are squash-merged and linked to their issue (`Closes #N`).
- Spike branches are investigations. Write code only when the exit criteria need proof, mark it THROWAWAY, and don't merge it.
- `upstream` stays as a read-only remote. Don't merge from it unless asked; an occasional `git fetch upstream` is enough to notice activity.
- Code branches follow AGENTS.MD: a CHANGELOG entry plus updates to the affected `docs/architecture/*.md`.

### Worktrees (required for code changes)

- Before the first edit of a code-change task, call `EnterWorktree`, named after the branch (e.g. `feat-25-ghostlight-voice-profile`). All edits, tests and commits happen inside it.
- `EnterWorktree` creates the branch as `worktree-<name>`. Rename it to the branch convention above (`git branch -m feat/25-ghostlight-voice-profile`).
- The root checkout stays on `main`. Never `git switch` or `git checkout` it; several sessions share it.
- Ask before the first push (ground rule 3), then push early. An unpushed branch dies with its worktree.
- Never use bare `git stash`/`pop`. All worktrees share one stash.
- Run `npm ci` in each new worktree. Don't share `node_modules`: better-sqlite3 is built per ABI (Node for tests, Electron for `npm start`).
- Read-only questions and investigations don't need a worktree.

### Issues and labels

- Type labels: `feature`, `enhancement` (improvements to existing behavior), `bug`, `chore`, `spike`. Area labels: `area:platform`, `area:security`, `area:workflow`.
- Spike issues have six parts: Question · Why it matters · Timebox · Method · Exit criteria · Output. The output is a findings comment plus proposed fork issues, or a stated reason for proposing none. Working notes go in `notes/<spike>.md`, which is untracked.

### Verify

- `npm run lint` (which is `tsc --noEmit`), `npm test` (its pretest rebuilds better-sqlite3 for the Node ABI), and `npm run test:coverage`. There is no `build` script; packaging is `npm run package` or `npm run make`.
- CI and releases use Node 20. `FORGE-CONFIG.md` says Node 22, and its `Root:` path is the maintainer's macOS checkout; ignore both.
