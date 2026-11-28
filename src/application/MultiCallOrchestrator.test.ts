import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@domain/types';
import { MultiCallOrchestrator } from './MultiCallOrchestrator';
import { StreamManager } from './StreamManager';
import { makeConversation, makeDb } from '../test/db';
import {
  makeFakeAgents,
  makeFakeFs,
  makeFakeRegistry,
  makeFakeSeries,
  makeFakeSettings,
  makeFakeVersion,
  makeModelInfo,
  makeScriptedProvider,
  makeUsageRecorder,
  type FakeFileSystem,
  type ScriptedProvider,
} from '../test/fakes';
import { DEFAULT_SETTINGS } from '@domain/constants';

let db: ReturnType<typeof makeDb>;
let fs: FakeFileSystem;
let provider: ScriptedProvider;
let orchestrator: MultiCallOrchestrator;
let events: StreamEvent[];
let conversationId: string;

/**
 * Provider impl that "writes" the given file for call N and finishes cleanly.
 * Files listed as null simulate a model that never called Write.
 */
function wireProviderWrites(filesPerCall: (string | null)[]): void {
  let call = 0;
  provider.setImpl(async (params) => {
    const file = filesPerCall[call];
    call++;
    if (file) {
      await fs.writeFile('book', file, `content of ${file}`);
      params.onEvent({ type: 'filesChanged', paths: [file] });
    }
    params.onEvent({ type: 'textDelta', text: `call ${call} output` });
    params.onEvent({ type: 'done', inputTokens: 10, outputTokens: 5, thinkingTokens: 0, filesTouched: file ? { [file]: 1 } : {} });
  });
}

function makeOrchestrator(fsFake: FakeFileSystem, seriesBiblePath: string | null = null): MultiCallOrchestrator {
  return new MultiCallOrchestrator(
    makeFakeSettings(),
    makeFakeAgents(),
    db,
    makeFakeRegistry(provider, { models: [makeModelInfo(DEFAULT_SETTINGS.model)] }),
    fsFake,
    new StreamManager(db, makeUsageRecorder().usage),
    makeFakeSeries(seriesBiblePath),
    makeFakeVersion()
  );
}

function run(agentName: 'Forge' | 'Ghostlight' | 'Lumen' | 'Sable' | 'Spark', authorNote?: string) {
  return orchestrator.runMultiCall({
    agentName,
    authorNote,
    conversationId,
    bookSlug: 'book',
    onEvent: (e) => events.push(e),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = makeDb();
  fs = makeFakeFs({ 'source/dev-report.md': 'dev findings here' }, { bookSlug: 'book' });
  provider = makeScriptedProvider();
  orchestrator = makeOrchestrator(fs);
  events = [];
  conversationId = makeConversation(db, { bookSlug: 'book', agentName: 'Forge' }).id;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('static step schemas (Forge)', () => {
  it('runs steps sequentially, verifies outputs, forwards only the final done, and merges changed files', async () => {
    wireProviderWrites(['source/project-tasks.md', 'source/revision-prompts.md']);

    const result = await run('Forge');

    expect(result.changedFiles).toEqual(['source/project-tasks.md', 'source/revision-prompts.md']);
    expect(provider.calls.length).toBe(2);
    expect(provider.calls.map((c) => c.maxTurns)).toEqual([15, 20]);
    expect(provider.calls[0].messages[0].content).toContain('Revision Task List');

    // Intermediate done intercepted — exactly one done reaches the caller
    expect(events.filter((e) => e.type === 'done').length).toBe(1);
    const progress = events.filter((e) => e.type === 'multiCallProgress');
    expect(progress.map((e) => (e.type === 'multiCallProgress' ? `${e.step}/${e.totalSteps}` : ''))).toEqual(['1/2', '2/2']);

    // Each step saved its prompt + assistant response in the conversation
    expect(db.getMessages(conversationId).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(db.getActiveStreamSessions()).toEqual([]); // all sub-sessions closed
  });

  it('retries a step whose expected file never appeared, bumping maxTurns, and aborts after 3 attempts', async () => {
    wireProviderWrites([null, null, null]); // step 1 never writes

    const result = await run('Forge');

    expect(provider.calls.length).toBe(3); // 3 attempts of step 1, step 2 never runs
    expect(provider.calls.map((c) => c.maxTurns)).toEqual([15, 20, 25]);
    expect(result.changedFiles).toEqual([]);

    const error = events.find((e) => e.type === 'error');
    expect(error?.message).toContain('failed after 3 attempts');
    expect(error?.message).toContain('never wrote its expected file source/project-tasks.md');
  });

  it('a failed attempt followed by success continues to the next step', async () => {
    wireProviderWrites([null, 'source/project-tasks.md', 'source/revision-prompts.md']);

    const result = await run('Forge');

    expect(provider.calls.map((c) => c.maxTurns)).toEqual([15, 20, 20]);
    expect(result.changedFiles).toEqual(['source/project-tasks.md', 'source/revision-prompts.md']);
    expect(events.some((e) => e.type === 'status' && e.message.includes('Retrying'))).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('provider error EVENTS (never-throw providers) count as step failures too', async () => {
    let call = 0;
    provider.setImpl(async (params) => {
      call++;
      if (call === 1) {
        params.onEvent({ type: 'error', message: 'model stalled' });
        return;
      }
      const file = call === 2 ? 'source/project-tasks.md' : 'source/revision-prompts.md';
      await fs.writeFile('book', file, 'x');
      params.onEvent({ type: 'filesChanged', paths: [file] });
      params.onEvent({ type: 'done', inputTokens: 1, outputTokens: 1, thinkingTokens: 0, filesTouched: { [file]: 1 } });
    });

    await run('Forge');

    expect(provider.calls.length).toBe(3);
    expect(events.some((e) => e.type === 'status' && e.message.includes('model stalled'))).toBe(true);
    expect(events.filter((e) => e.type === 'error').length).toBe(0); // recovered — no terminal error
  });

  it('runs Forge three times: every step runs and every earlier plan is kept (#81)', async () => {
    let call = 0;
    provider.setImpl(async (params) => {
      call++;
      const file = params.messages[0].content.includes('Build the Session Map table')
        ? 'source/revision-prompts.md'
        : 'source/project-tasks.md';
      await fs.writeFile('book', file, `${file} from call ${call}`);
      params.onEvent({ type: 'done', inputTokens: 1, outputTokens: 1, thinkingTokens: 0, filesTouched: { [file]: 1 } });
    });

    for (let pass = 1; pass <= 3; pass++) {
      await run('Forge');
      // Verity runs the plan and leaves a handoff
      fs.files.set('book/source/session-handoffs/session-01.md', `handoff from pass ${pass}`);
    }

    expect(provider.calls.length).toBe(6); // both steps, every pass
    expect(events.some((e) => e.type === 'multiCallProgress' && e.label.includes('(cached)'))).toBe(false);
    expect(fs.files.get('book/source/project-tasks-v1.md')).toBe('source/project-tasks.md from call 1');
    expect(fs.files.get('book/source/revision-prompts-v1.md')).toBe('source/revision-prompts.md from call 2');
    expect(fs.files.get('book/source/session-handoffs-v1/session-01.md')).toBe('handoff from pass 1');
    expect(fs.files.get('book/source/project-tasks-v2.md')).toBe('source/project-tasks.md from call 3');
    expect(fs.files.get('book/source/revision-prompts-v2.md')).toBe('source/revision-prompts.md from call 4');
    expect(fs.files.get('book/source/session-handoffs-v2/session-01.md')).toBe('handoff from pass 2');
    expect(fs.files.get('book/source/project-tasks.md')).toBe('source/project-tasks.md from call 5');
    expect(fs.files.get('book/source/revision-prompts.md')).toBe('source/revision-prompts.md from call 6');
    expect(events.some((e) => e.type === 'status' && e.message === 'The earlier plan is kept as version 2.')).toBe(true);
    expect([...fs.files.keys()].filter((k) => k.includes('.scratch'))).toEqual([]);
  });

  it('resumes an interrupted run only from steps that run finished (#81)', async () => {
    // Pass 1: the task list is written, then session prompts fail every attempt
    wireProviderWrites(['source/project-tasks.md', null, null, null]);
    await run('Forge');
    expect(fs.files.has('book/source/.scratch/forge-run.json')).toBe(true);

    // Pass 2, nothing changed: only the session prompts run
    events = [];
    const before = provider.calls.length;
    wireProviderWrites(['source/revision-prompts.md']);
    await run('Forge');

    expect(provider.calls.length - before).toBe(1);
    expect(provider.calls.at(-1)!.messages[0].content).toContain('Session Map');
    expect(events.some((e) => e.type === 'status' && e.message.startsWith('Resuming: 1 of 2'))).toBe(true);
    expect(events.some((e) => e.type === 'multiCallProgress' && e.label.includes('(cached)'))).toBe(true);
    expect(fs.files.has('book/source/project-tasks-v1.md')).toBe(false); // the run's own task list stays live
    expect(fs.files.has('book/source/.scratch/forge-run.json')).toBe(false); // record removed after success
  });

  it('starts over when a report changed since the interrupted run (#81)', async () => {
    wireProviderWrites(['source/project-tasks.md', null, null, null]);
    await run('Forge');

    fs.files.set('book/source/dev-report.md', 'a newer assessment'); // Lumen ran again
    events = [];
    const before = provider.calls.length;
    wireProviderWrites(['source/project-tasks.md', 'source/revision-prompts.md']);
    await run('Forge');

    expect(provider.calls.length - before).toBe(2); // the task list is rebuilt from the new report
    expect(events.some((e) => e.type === 'status' && e.message.includes('starts over'))).toBe(true);
    // The interrupted run's task list is kept, not silently reused
    expect(fs.files.get('book/source/project-tasks-v1.md')).toBe('content of source/project-tasks.md');
  });

  it('throws for agents without step schemas', async () => {
    await expect(run('Spark')).rejects.toThrow(/No multi-call steps defined/);
  });
});

describe('author note (#111)', () => {
  it('appends the author note to every step prompt', async () => {
    wireProviderWrites(['source/project-tasks.md', 'source/revision-prompts.md']);

    await run('Forge', 'Keep chapter 7 as it is.');

    expect(provider.calls).toHaveLength(2);
    for (const call of provider.calls) {
      expect(call.messages[0].content).toContain('Keep chapter 7 as it is.');
    }
  });

  it('adds nothing without a note', async () => {
    wireProviderWrites(['source/project-tasks.md', 'source/revision-prompts.md']);

    await run('Forge');

    for (const call of provider.calls) {
      expect(call.messages[0].content).not.toContain('Author note');
    }
  });
});

describe('dynamic step expansion (Ghostlight)', () => {
  beforeEach(() => {
    // 5 chapters × 10k words → 50k words → 3 read batches at 20k/batch
    const chapterWords = 'w '.repeat(10_000).trim();
    fs = makeFakeFs(
      Object.fromEntries(
        [1, 2, 3, 4, 5].map((n) => [`chapters/0${n}-ch/draft.md`, chapterWords])
      ),
      { bookSlug: 'book' }
    );
    orchestrator = makeOrchestrator(fs);
  });

  it('expands read batches by word count, threads scratch refs, and cleans up after synthesis', async () => {
    wireProviderWrites([
      'source/.scratch/ghostlight-read-1.md',
      'source/.scratch/ghostlight-read-2.md',
      'source/.scratch/ghostlight-read-3.md',
      'source/reader-report.md',
    ]);

    const result = await run('Ghostlight');

    expect(provider.calls.length).toBe(4);

    // Batch prompts: chapter lists injected, prior-batch refs renumbered
    expect(provider.calls[0].messages[0].content).toContain('chapters/01-ch/draft.md');
    expect(provider.calls[1].messages[0].content).toContain('source/.scratch/ghostlight-read-1.md'); // reads prior
    expect(provider.calls[1].messages[0].content).toContain('source/.scratch/ghostlight-read-2.md'); // writes own
    expect(provider.calls[2].messages[0].content).toContain('source/.scratch/ghostlight-read-2.md');

    // Synthesis placeholders resolved
    const synthesis = provider.calls[3].messages[0].content;
    expect(synthesis).toContain('EXACTLY 3 files to read');
    expect(synthesis).toContain('- source/.scratch/ghostlight-read-1.md');
    expect(synthesis).toContain('- source/.scratch/ghostlight-read-3.md');

    // Read steps use the lightweight system prompt; synthesis gets the agent's own
    expect(provider.calls[0].systemPrompt).toContain('You are Ghostlight (First Reader)');
    expect(provider.calls[0].systemPrompt).not.toContain('Ghostlight system prompt');
    expect(provider.calls[3].systemPrompt).toContain('Ghostlight system prompt');

    // Progress covers all 4 expanded steps
    const labels = events
      .filter((e) => e.type === 'multiCallProgress')
      .map((e) => (e.type === 'multiCallProgress' ? e.label : ''));
    expect(labels).toEqual(['Read Batch 1/3', 'Read Batch 2/3', 'Read Batch 3/3', 'Synthesize Reader Report']);

    // Scratch files cleaned up after successful synthesis; output remains
    expect([...fs.files.keys()].filter((k) => k.includes('.scratch'))).toEqual([]);
    expect(fs.files.has('book/source/reader-report.md')).toBe(true);
    expect(result.changedFiles).toContain('source/reader-report.md');
  });

  it('a failed read batch preserves scratch files from completed steps', async () => {
    wireProviderWrites([
      'source/.scratch/ghostlight-read-1.md',
      null, null, null, // batch 2 never writes → exhausts retries
    ]);

    await run('Ghostlight');

    expect(fs.files.has('book/source/.scratch/ghostlight-read-1.md')).toBe(true); // survives for retry
    expect(events.find((e) => e.type === 'error')?.message).toContain('Prior results saved in source/.scratch/');
  });

  it('re-reads every batch when a chapter changed since the interrupted read (#81)', async () => {
    wireProviderWrites(['source/.scratch/ghostlight-read-1.md', null, null, null]);
    await run('Ghostlight');

    // Same word count, different text: the old batch notes describe a chapter that no longer exists
    fs.files.set('book/chapters/01-ch/draft.md', `x ${'w '.repeat(9_999).trim()}`);
    events = [];
    const before = provider.calls.length;
    wireProviderWrites([
      'source/.scratch/ghostlight-read-1.md',
      'source/.scratch/ghostlight-read-2.md',
      'source/.scratch/ghostlight-read-3.md',
      'source/reader-report.md',
    ]);
    await run('Ghostlight');

    expect(provider.calls.length - before).toBe(4);
    expect(events.some((e) => e.type === 'status' && e.message.includes('starts over'))).toBe(true);
  });

  it('keeps the earlier reader report as the next version before a new read (#81)', async () => {
    fs.files.set('book/source/reader-report.md', 'first read');
    wireProviderWrites([
      'source/.scratch/ghostlight-read-1.md',
      'source/.scratch/ghostlight-read-2.md',
      'source/.scratch/ghostlight-read-3.md',
      'source/reader-report.md',
    ]);

    await run('Ghostlight');

    expect(fs.files.get('book/source/reader-report-v1.md')).toBe('first read');
    expect(fs.files.get('book/source/reader-report.md')).toBe('content of source/reader-report.md');
  });

  it('adds no archive when Complete Revision already kept the report, and fails a synthesis that leaves it unchanged (#81)', async () => {
    fs.files.set('book/source/reader-report.md', 'first read');
    fs.files.set('book/source/reader-report-v1.md', 'first read');
    wireProviderWrites([
      'source/.scratch/ghostlight-read-1.md',
      'source/.scratch/ghostlight-read-2.md',
      'source/.scratch/ghostlight-read-3.md',
      null, null, null, // synthesis never writes
    ]);

    await run('Ghostlight');

    expect(fs.files.has('book/source/reader-report-v2.md')).toBe(false);
    expect(events.find((e) => e.type === 'error')?.message).toContain('left source/reader-report.md unchanged');
  });
});

// ── #23: each step carries the agent's prompt or reading rules ─────────

describe('agent prompts and reading rules per step (#23)', () => {
  // 2 chapters × 5k words → 1 read batch. Chapter 01 has notes, 02 does not.
  beforeEach(() => {
    const words = 'w '.repeat(5_000).trim();
    fs = makeFakeFs(
      {
        'chapters/01-ch/draft.md': words,
        'chapters/01-ch/notes.md': 'author notes',
        'chapters/02-ch/draft.md': words,
        'source/pitch.md': 'pitch',
        'source/voice-profile.md': 'voice',
      },
      { bookSlug: 'book' }
    );
    orchestrator = makeOrchestrator(fs);
  });

  /** Runs the agent with every step writing its own target file. */
  async function runAll(agent: 'Ghostlight' | 'Lumen' | 'Sable') {
    provider.setImpl(async (params) => {
      // Read steps name their tracker in the user prompt; full-prompt steps
      // name their target in the step instructions.
      const target =
        params.messages[0].content.match(/create `(source\/\.scratch\/[\w-]+\.md)` before finishing/)?.[1] ??
        params.systemPrompt.match(/not complete until `([^`]+)` is written/)?.[1];
      if (target) await fs.writeFile('book', target, 'x');
      params.onEvent({ type: 'done', inputTokens: 1, outputTokens: 1, thinkingTokens: 0, filesTouched: {} });
    });
    await run(agent);
    expect(events.some((e) => e.type === 'error'), JSON.stringify(events.filter((e) => e.type === 'error'))).toBe(false);
    return provider.calls;
  }

  it.each(['Ghostlight', 'Lumen', 'Sable'] as const)('%s synthesis gets the full agent prompt plus step instructions', async (agent) => {
    const calls = await runAll(agent);
    const synthesis = calls[calls.length - 1].systemPrompt;
    expect(synthesis).toContain(`${agent} system prompt`);
    expect(synthesis).toContain('## Context Loading Guidance');
    expect(synthesis).toMatch(new RegExp(`## Multi-Call Step ${calls.length} of ${calls.length}: Synthesize`));
    expect(synthesis).toContain('No author is present to approve writes');
    expect(synthesis).not.toContain('Your job in this step is to read chapters');
  });

  it('Ghostlight read steps never see or list chapter notes', async () => {
    const calls = await runAll('Ghostlight');
    const read = calls[0];
    expect(read.systemPrompt).toContain('You are Ghostlight (First Reader)');
    expect(read.systemPrompt).toContain('## Reading Rules');
    expect(read.systemPrompt).toContain('`chapters/*/notes.md`');
    expect(read.systemPrompt).toContain('Never open any `notes.md` file');

    const available = read.systemPrompt.split('## Available Files')[1].split('## Reading Rules')[0];
    expect(available).toContain('chapters/01-ch/draft.md');
    expect(available).not.toContain('notes.md');
    expect(available).not.toContain('source/pitch.md');

    expect(read.messages[0].content).toContain('chapters/01-ch/draft.md');
    expect(read.messages[0].content).not.toContain('chapters/01-ch/notes.md');
  });

  it('Ghostlight reads the voice profile only in synthesis, after the trackers (#25)', async () => {
    const calls = await runAll('Ghostlight');
    const read = calls[0];
    const synthesis = calls[calls.length - 1];

    // Read step: not listed, and named as belonging to a later step
    const available = read.systemPrompt.split('## Available Files')[1].split('## Reading Rules')[0];
    expect(available).not.toContain('voice-profile');
    expect(read.systemPrompt).toMatch(/- \*\*Not in this step\*\*.*`source\/voice-profile\.md`/);
    expect(read.messages[0].content).not.toContain('voice-profile');

    // Synthesis: guidance names it as post-pass, and the task reads it after the trackers
    expect(synthesis.systemPrompt).toMatch(/- \*\*Read only after your main pass is done\*\*.*`source\/voice-profile\.md`/);
    const task = synthesis.messages[0].content;
    expect(task.indexOf('source/.scratch/ghostlight-read-1.md')).toBeLessThan(task.indexOf('**Step 2.**'));
    expect(task).toContain('**Step 2.** If `source/voice-profile.md` is in the file manifest, read it.');
    expect(task).toContain('- Intent vs. experience (last section, short; only if the voice profile exists)');
  });

  it('on a series book, no Ghostlight step gets the series bible; Lumen synthesis does (#61)', async () => {
    const biblePath = '/abs/series/saga/series-bible.md';
    orchestrator = makeOrchestrator(fs, biblePath);

    const ghostlight = [...(await runAll('Ghostlight'))];
    expect(ghostlight.length).toBeGreaterThan(1); // read step(s) + synthesis
    for (const call of ghostlight) {
      expect(call.systemPrompt).not.toContain(biblePath);
      expect(call.systemPrompt).not.toContain('### Series Context');
    }

    const lumenSynthesis = (await runAll('Lumen')).at(-1)!;
    expect(lumenSynthesis.systemPrompt).toContain(`The shared series bible is at: \`${biblePath}\``);
  });

  it.each(['Lumen', 'Sable'] as const)('%s read steps list each chapter\'s notes and carry the read-notes rule', async (agent) => {
    const calls = await runAll(agent);
    const read = calls[0];
    expect(read.systemPrompt).toContain(`You are ${agent}`);
    expect(read.systemPrompt).toContain('Before each chapter, read its `notes.md`');
    expect(read.systemPrompt).not.toContain(`${agent} system prompt`);

    const prompt = read.messages[0].content;
    expect(prompt).toContain('- notes: `chapters/01-ch/notes.md`');
    expect(prompt).not.toContain('chapters/02-ch/notes.md');
  });
});
