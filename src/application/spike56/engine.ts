// THROWAWAY — spike #56 (iteration model). Proof code only; not for merge.
import { createHash } from 'node:crypto';
import type { AgentName } from '@domain/types';
import type { IFileSystemService } from '@domain/interfaces';
import { archiveGroup, archivePath, archivePlan, archiveVersions, PLAN_FILES } from '../archives';
import { ADD_PASS_FOLLOW_ONS, PASS_TEMPLATES, PHASE_TYPES, outputsOf, type PassKind, type PhaseType } from './model';
import {
  RUN_LOG_PATH,
  currentRun,
  fold,
  nextPassId,
  nextRunIds,
  parseLog,
  serialize,
  stamp,
  type ChapterRef,
  type Folded,
  type NewEvent,
  type OutputRef,
  type Run,
  type RunEvent,
} from './runLog';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Draft snapshots: `drafts/draft-01/`, one flat file per chapter, never matched by `chapters/*\/draft.md`. */
export const DRAFTS_DIR = 'drafts';
export const draftDir = (n: number): string => `${DRAFTS_DIR}/draft-${String(n).padStart(2, '0')}`;

async function readOrNull(fs: IFileSystemService, slug: string, path: string): Promise<string | null> {
  try {
    return await fs.readFile(slug, path);
  } catch {
    return null;
  }
}

export class RunEngine {
  constructor(
    private fs: IFileSystemService,
    private slug: string,
    private clock: () => string = () => new Date().toISOString(),
  ) {}

  // ── Log I/O ───────────────────────────────────────────────────────────

  async events(): Promise<{ events: RunEvent[]; badLines: number }> {
    const raw = await readOrNull(this.fs, this.slug, RUN_LOG_PATH);
    return raw === null ? { events: [], badLines: 0 } : parseLog(raw);
  }

  async load(): Promise<Folded> {
    const { events, badLines } = await this.events();
    return fold(events, badLines);
  }

  /**
   * Append events. The real service would add `appendFile` to
   * IFileSystemService; the spike rewrites the file (parse skips a torn line).
   */
  async append(bodies: NewEvent[]): Promise<Folded> {
    const { events } = await this.events();
    const lastSeq = events.reduce((m, ev) => Math.max(m, ev.seq), 0);
    const all = [...events, ...stamp(bodies, lastSeq, this.clock())];
    fold(all); // validate before writing
    await this.fs.writeFile(this.slug, RUN_LOG_PATH, serialize(all));
    return fold(all);
  }

  // ── Plan edits ────────────────────────────────────────────────────────

  /** Plan a fresh book: the default passes, in order. */
  async planDefault(kinds: PassKind[], origin: 'template' | 'import' = 'template'): Promise<Folded> {
    const { events } = await this.events();
    const bodies: NewEvent[] = [];
    let after: string | null = null;
    let passNo = Number(nextPassId(events).slice(1));
    let runNo = Number(nextRunIds(events, 1)[0].slice(1));
    for (const kind of kinds) {
      const pass = `p${passNo++}`;
      for (const phase of PASS_TEMPLATES[kind].phases) {
        const run = `r${runNo++}`;
        bodies.push({ e: 'planned', run, phase, pass, passKind: kind, after, origin });
        after = run;
      }
    }
    return this.append(bodies);
  }

  /**
   * Add a pass. It goes right before the current run (or after `afterRun`),
   * so nothing done is reverted. A started run that gets pushed back is
   * deferred: it restarts with a fresh baseline after the pass.
   */
  async addPass(
    kind: PassKind,
    opts: {
      drop?: PhaseType[];
      label?: string;
      origin?: 'author' | 'agent';
      proposedBy?: AgentName;
      reason?: string;
      afterRun?: string | null;
      followOns?: boolean;
    } = {},
  ): Promise<{ folded: Folded; runIds: string[] }> {
    const { events } = await this.events();
    const folded = fold(events);

    let after: string | null;
    let next: Run | null = null;
    const bodies: NewEvent[] = [];
    if (opts.afterRun !== undefined) {
      after = opts.afterRun;
      const idx = after === null ? 0 : folded.runs.findIndex((r) => r.id === after) + 1;
      next = folded.runs[idx] ?? null;
    } else {
      const current = currentRun(folded);
      const idx = current ? folded.runs.findIndex((r) => r.id === current.id) : folded.runs.length;
      after = idx > 0 ? folded.runs[idx - 1].id : null;
      next = current;
      // An agent's proposal waits for approval before it pushes the current run back.
      if (current?.state === 'active' && opts.origin !== 'agent') bodies.push({ e: 'deferred', run: current.id });
    }

    // A suggested follow-on is dropped when the run it would precede is the same step.
    const followOns = (opts.followOns === false ? [] : ADD_PASS_FOLLOW_ONS[kind] ?? []).filter(
      (p, i, all) => !(i === all.length - 1 && next?.phase === p && next.state !== 'done'),
    );
    const phases = [...PASS_TEMPLATES[kind].phases, ...followOns].filter((p) => !(opts.drop ?? []).includes(p));

    const pass = nextPassId(events);
    const runIds = nextRunIds(events, phases.length);
    phases.forEach((phase, i) => {
      bodies.push({
        e: 'planned',
        run: runIds[i],
        phase,
        pass,
        passKind: kind,
        after,
        origin: opts.origin ?? 'author',
        label: opts.label,
        proposedBy: opts.proposedBy,
        reason: opts.reason,
      });
      after = runIds[i];
    });
    return { folded: await this.append(bodies), runIds };
  }

  /** Approve an agent's proposed pass. A started run after it is deferred until the pass is done. */
  async approvePass(passId: string): Promise<Folded> {
    const folded = await this.load();
    const proposed = folded.runs.filter((r) => r.pass === passId && r.state === 'proposed');
    const lastIdx = Math.max(...proposed.map((r) => folded.runs.indexOf(r)));
    const bodies: NewEvent[] = proposed.map((r) => ({ e: 'approved', run: r.id }));
    for (const r of folded.runs.slice(lastIdx + 1)) {
      if (r.state === 'active') bodies.push({ e: 'deferred', run: r.id });
    }
    return this.append(bodies);
  }

  async declinePass(passId: string): Promise<Folded> {
    const folded = await this.load();
    return this.append(
      folded.runs.filter((r) => r.pass === passId && r.state === 'proposed').map((r) => ({ e: 'declined', run: r.id }) as NewEvent),
    );
  }

  async skip(runId: string, reason: string): Promise<Folded> {
    return this.append([{ e: 'skipped', run: runId, reason }]);
  }

  // ── Running ───────────────────────────────────────────────────────────

  /**
   * Start a run. Before anything can overwrite them, live outputs are archived
   * under the next free `-vN` (copy for reports, move for Forge's plan, as
   * today). The baseline records output hashes so completion never compares
   * word counts. A rewriting run first snapshots the manuscript as a draft.
   */
  async start(runId: string): Promise<Folded> {
    const folded = await this.load();
    const run = this.run(folded, runId);
    const bodies: NewEvent[] = [];

    const outputs = outputsOf(run.phase, this.slug);
    if (outputs.length > 0) {
      const isPlan = PLAN_FILES.every((f) => outputs.includes(f));
      const before = await Promise.all(outputs.map((p) => readOrNull(this.fs, this.slug, p)));
      const result = isPlan
        ? await archivePlan(this.fs, this.slug, 'move')
        : await archiveGroup(this.fs, this.slug, outputs, 'copy');
      if (result?.created) {
        outputs.forEach((p, i) => {
          const content = before[i];
          if (content !== null) bodies.push({ e: 'archived', path: p, to: archivePath(p, result.version), sha256: sha256(content) });
        });
      }
    }

    let draft: number | undefined;
    if (PHASE_TYPES[run.phase].rewrites) {
      const snap = await this.snapshotDraft(folded, `before ${run.id} (${PHASE_TYPES[run.phase].label})`);
      if (snap) {
        bodies.push(snap);
        draft = snap.draft;
      }
    }

    const baseline: Record<string, string | null> = {};
    for (const p of outputs) {
      const content = await readOrNull(this.fs, this.slug, p);
      baseline[p] = content === null ? null : sha256(content);
    }
    bodies.push({ e: 'started', run: runId, baseline, draft });
    return this.append(bodies);
  }

  /** Ready to confirm: the author sees Advance. No word-count comparisons. */
  async isPending(run: Run): Promise<boolean> {
    if (run.state !== 'active') return false;
    const def = PHASE_TYPES[run.phase];
    if (def.gate === 'action') return run.baseline === null;
    const outputs = outputsOf(run.phase, this.slug);
    let changed = run.baseline === null;
    for (const p of outputs) {
      const content = await readOrNull(this.fs, this.slug, p);
      if (content === null || countWords(content) < (def.minWords ?? 50)) return false;
      if (run.baseline && run.baseline[p] !== sha256(content)) changed = true;
    }
    return changed;
  }

  /** Done: record the outputs by content. Nothing is written but the log. */
  async done(runId: string): Promise<Folded> {
    const folded = await this.load();
    const run = this.run(folded, runId);
    const outputs: OutputRef[] = [];
    for (const p of outputsOf(run.phase, this.slug)) {
      const content = await readOrNull(this.fs, this.slug, p);
      if (content !== null) outputs.push({ path: p, sha256: sha256(content), words: countWords(content) });
    }
    return this.append([{ e: 'done', run: runId, outputs }]);
  }

  // ── Lookups ───────────────────────────────────────────────────────────

  /** Where a run's output lives now: the live file or one of its archives. Null if edited away. */
  async resolve(ref: OutputRef, folded?: Folded): Promise<string | null> {
    const live = await readOrNull(this.fs, this.slug, ref.path);
    if (live !== null && sha256(live) === ref.sha256) return ref.path;
    const log = folded ?? (await this.load());
    const hit = [...log.archived].reverse().find((a) => a.sha256 === ref.sha256 && a.path === ref.path);
    if (hit && (await readOrNull(this.fs, this.slug, hit.to)) !== null) return hit.to;
    // Archives the log never saw (made before migration): scan by content.
    for (const v of (await archiveVersions(this.fs, this.slug, ref.path)).reverse()) {
      const p = archivePath(ref.path, v);
      const content = await readOrNull(this.fs, this.slug, p);
      if (content !== null && sha256(content) === ref.sha256) return p;
    }
    return null;
  }

  /**
   * What a run should read, from the log instead of fixed paths. An
   * assessment reads every reader report since the previous assessment
   * (siblings, #62); a readiness check also reads the previous check (#89).
   */
  inputsFor(folded: Folded, runId: string): OutputRef[] {
    const idx = folded.runs.findIndex((r) => r.id === runId);
    const before = folded.runs.slice(0, idx).filter((r) => r.state === 'done');
    const since = (type: PhaseType, stop: PhaseType): OutputRef[] => {
      const out: OutputRef[] = [];
      for (const r of [...before].reverse()) {
        if (r.phase === stop) break;
        if (r.phase === type) out.unshift(...r.outputs);
      }
      return out;
    };
    const latest = (type: PhaseType): OutputRef[] => [...before].reverse().find((r) => r.phase === type)?.outputs ?? [];
    switch (this.run(folded, runId).phase) {
      case 'assessment':
        return since('read', 'assessment');
      case 'revision-plan':
        return [...since('read', 'revision-plan'), ...latest('assessment')];
      case 'fix-plan':
        return latest('copy-edit');
      case 'readiness':
        return [...latest('readiness'), ...latest('read')];
      default:
        return [];
    }
  }

  // ── Draft snapshots ───────────────────────────────────────────────────

  private async chapters(): Promise<{ slug: string; draft: string; notes: string | null }[]> {
    let dirs: { name: string; isDirectory: boolean }[];
    try {
      dirs = await this.fs.listDirectory(this.slug, 'chapters');
    } catch {
      return [];
    }
    const out: { slug: string; draft: string; notes: string | null }[] = [];
    for (const d of dirs.filter((d) => d.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
      const draft = await readOrNull(this.fs, this.slug, `chapters/${d.name}/draft.md`);
      if (draft === null) continue;
      out.push({ slug: d.name, draft, notes: await readOrNull(this.fs, this.slug, `chapters/${d.name}/notes.md`) });
    }
    return out;
  }

  /**
   * Copy the manuscript to `drafts/draft-NN/` when it has body text and
   * differs from the newest snapshot. Holds each chapter's draft.md (and
   * notes.md), the scene outline and story bible, and a draft.json manifest.
   */
  async snapshotDraft(folded: Folded, reason: string): Promise<Extract<NewEvent, { e: 'snapshot' }> | null> {
    const chapters = await this.chapters();
    const refs: ChapterRef[] = chapters.map((c) => ({ slug: c.slug, sha256: sha256(c.draft), words: countWords(c.draft) }));
    const body = refs.filter((r) => !/^00-\d+-/.test(r.slug));
    if (body.reduce((n, r) => n + r.words, 0) === 0) return null;
    const last = folded.drafts[folded.drafts.length - 1];
    if (last && JSON.stringify(last.chapters) === JSON.stringify(refs)) return null;

    const n = (last?.draft ?? 0) + 1;
    const dir = draftDir(n);
    for (const c of chapters) {
      await this.fs.writeFile(this.slug, `${dir}/${c.slug}.md`, c.draft);
      if (c.notes !== null) await this.fs.writeFile(this.slug, `${dir}/${c.slug}.notes.md`, c.notes);
    }
    for (const src of ['source/scene-outline.md', 'source/story-bible.md']) {
      const content = await readOrNull(this.fs, this.slug, src);
      if (content !== null) await this.fs.writeFile(this.slug, `${dir}/${src}`, content);
    }
    await this.fs.writeFile(
      this.slug,
      `${dir}/draft.json`,
      JSON.stringify({ draft: n, label: `Draft ${n}`, reason, takenAt: this.clock(), chapters: refs }, null, 2),
    );
    return { e: 'snapshot', draft: n, dir, reason, chapters: refs };
  }

  /** Restore a draft's chapters. The current text is snapshotted first, so nothing is lost. */
  async restoreDraft(n: number): Promise<Folded> {
    const folded = await this.load();
    const target = folded.drafts.find((d) => d.draft === n);
    if (!target) throw new Error(`No draft ${n}`);
    const bodies: NewEvent[] = [];
    const pre = await this.snapshotDraft(folded, `before restoring Draft ${n}`);
    if (pre) bodies.push(pre);
    const keep = new Set(target.chapters.map((c) => c.slug));
    for (const c of await this.chapters()) {
      if (!keep.has(c.slug)) await this.fs.deletePath(this.slug, `chapters/${c.slug}`);
    }
    for (const c of target.chapters) {
      const text = await this.fs.readFile(this.slug, `${target.dir}/${c.slug}.md`);
      await this.fs.writeFile(this.slug, `chapters/${c.slug}/draft.md`, text);
    }
    return this.append(bodies);
  }

  private run(folded: Folded, runId: string): Run {
    const run = folded.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    return run;
  }
}
