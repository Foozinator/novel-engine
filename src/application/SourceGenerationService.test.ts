import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceGenerationEvent, StreamEvent } from '@domain/types';
import { SourceGenerationService, SOURCE_GENERATION_MAX_TURNS } from './SourceGenerationService';
import { makeDb } from '../test/db';
import {
  makeFakeAgents,
  makeFakeFs,
  makeFakeRegistry,
  makeFakeSettings,
  makeModelInfo,
  makeScriptedProvider,
  type ScriptedProvider,
} from '../test/fakes';
import { DEFAULT_SETTINGS } from '@domain/constants';

let db: ReturnType<typeof makeDb>;
let provider: ScriptedProvider;
let service: SourceGenerationService;
let fs: ReturnType<typeof makeFakeFs>;
let progress: SourceGenerationEvent[];
let streamEvents: StreamEvent[];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = makeDb();
  provider = makeScriptedProvider();
  fs = makeFakeFs({ 'chapters/01-one/draft.md': 'imported prose' });
  service = new SourceGenerationService(
    makeFakeSettings({ enableThinking: true }),
    makeFakeAgents(),
    db,
    fs,
    makeFakeRegistry(provider, { models: [makeModelInfo(DEFAULT_SETTINGS.model)] })
  );
  progress = [];
  streamEvents = [];
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const VALID_LEDGER = JSON.stringify({
  systems: [], entries: [], structuralDevices: [], foreshadows: [],
  minorCharacters: [], flaggedPhrases: [], auditLog: [],
});

const OUTPUTS: Record<string, Record<string, string>> = {
  'source/pitch.md': { 'source/pitch.md': '# Pitch' },
  'source/scene-outline.md': { 'source/scene-outline.md': '# Outline', 'source/story-bible.md': '# Bible' },
  'source/voice-profile.md': { 'source/voice-profile.md': '# Voice' },
  'source/motif-ledger.json': { 'source/motif-ledger.json': VALID_LEDGER },
};

/** Provider that writes the files each step's prompt asks for, like a real agent. */
const writingImpl = (overrides: Record<string, string> = {}) => async (params: any) => {
  const prompt: string = params.messages.at(-1).content;
  const key = Object.keys(OUTPUTS).find((k) => prompt.includes(k))!;
  for (const [path, content] of Object.entries({ ...OUTPUTS[key], ...overrides })) {
    if (path in OUTPUTS[key]) await fs.writeFile('test-book', path, content);
  }
  params.onEvent({ type: 'textDelta', text: 'done' });
  params.onEvent({ type: 'done', inputTokens: 0, outputTokens: 0, thinkingTokens: 0, filesTouched: {} });
};

const generate = (stepIndexes?: number[]) =>
  service.generate({
    stepIndexes,
    bookSlug: 'test-book',
    onProgress: (e) => progress.push(e),
    onStreamEvent: (e) => streamEvents.push(e),
  });

describe('generate', () => {
  it('runs the 4 steps sequentially with progress events and persists each exchange', async () => {
    provider.setImpl(writingImpl());

    await generate();

    expect(progress.map((e) => e.type)).toEqual([
      'started',
      'step-started', 'step-done',
      'step-started', 'step-done',
      'step-started', 'step-done',
      'step-started', 'step-done',
      'done',
    ]);

    const started = progress[0];
    if (started.type === 'started') {
      expect(started.steps.map((s) => s.agentName)).toEqual(['Spark', 'Verity', 'Verity', 'Verity']);
    }

    expect(provider.calls.length).toBe(4);
    expect(provider.calls[0].thinkingBudget).toBe(4000);
    expect(provider.calls.every((c) => c.maxTurns === SOURCE_GENERATION_MAX_TURNS)).toBe(true);
    expect(provider.calls[0].messages.at(-1)?.content).toContain('write it to source/pitch.md');
    expect(provider.calls[3].messages.at(-1)?.content).toContain('source/motif-ledger.json');

    // Unattended instructions replace the approval-first rule and the read guidance
    for (const c of provider.calls) {
      expect(c.systemPrompt).toContain('unattended run');
      expect(c.systemPrompt).not.toContain('Always ask for explicit approval');
      expect(c.systemPrompt).not.toContain('Context Loading Guidance');
    }

    for (const path of ['source/pitch.md', 'source/scene-outline.md', 'source/story-bible.md', 'source/voice-profile.md', 'source/motif-ledger.json']) {
      expect(fs.files.has(`test-book/${path}`)).toBe(true);
    }

    const conversations = db.listConversations('test-book');
    expect(conversations.length).toBe(4);
    for (const conversation of conversations) {
      expect(db.getMessages(conversation.id).map((m) => m.role)).toEqual(['user', 'assistant']);
    }
    expect(streamEvents.filter((e) => e.type === 'textDelta').length).toBe(4);
  });

  it('a step whose file was never written reports step-error, and the others still run', async () => {
    // The provider reports success but writes nothing (the bug in #82)
    let call = 0;
    const real = writingImpl();
    provider.setImpl(async (params) => {
      call++;
      if (call === 2) {
        params.onEvent({ type: 'done', inputTokens: 0, outputTokens: 0, thinkingTokens: 0, filesTouched: {} });
        return;
      }
      return real(params);
    });

    await generate();

    expect(progress.filter((e) => e.type === 'step-done').map((e) => (e.type === 'step-done' ? e.index : -1))).toEqual([0, 2, 3]);
    const err = progress.find((e) => e.type === 'step-error');
    expect(err).toMatchObject({ index: 1 });
    expect(err && err.type === 'step-error' && err.message).toContain('source/scene-outline.md');
    expect(progress.at(-1)?.type).toBe('done');
  });

  it('a step that leaves an existing file unchanged is an error', async () => {
    fs.files.set('test-book/source/pitch.md', '# Pitch');
    provider.setImpl(writingImpl());

    await generate([0]);

    expect(progress).toContainEqual({ type: 'step-error', index: 0, message: 'The agent finished without changing source/pitch.md.' });
  });

  it('rejects an invalid motif ledger', async () => {
    provider.setImpl(writingImpl({ 'source/motif-ledger.json': '{"systems": []}' }));

    await generate([3]);

    const err = progress.find((e) => e.type === 'step-error');
    expect(err && err.type === 'step-error' && err.message).toContain('missing array fields');
    expect(progress.some((e) => e.type === 'step-done')).toBe(false);

    provider.setImpl(writingImpl({ 'source/motif-ledger.json': 'not json' }));
    progress.length = 0;
    await generate([3]);
    const err2 = progress.find((e) => e.type === 'step-error');
    expect(err2 && err2.type === 'step-error' && err2.message).toContain('not valid JSON');
  });

  it('retrying only the failed step runs just that step and succeeds', async () => {
    provider.setImpl(async (params) => {
      params.onEvent({ type: 'done', inputTokens: 0, outputTokens: 0, thinkingTokens: 0, filesTouched: {} });
    });
    await generate([3]);
    expect(progress.some((e) => e.type === 'step-error')).toBe(true);

    progress.length = 0;
    provider.calls.length = 0;
    provider.setImpl(writingImpl());
    await generate([3]);

    expect(provider.calls.length).toBe(1);
    expect(progress[0]).toMatchObject({ type: 'started', steps: [{ index: 3 }] });
    expect(progress.filter((e) => e.type === 'step-done')).toEqual([{ type: 'step-done', index: 3 }]);
  });

  it('moves generated flaggedPhrases into an audit-log observation', async () => {
    const ledger = JSON.stringify({
      systems: [], entries: [], structuralDevices: [], foreshadows: [], minorCharacters: [],
      flaggedPhrases: [{ id: 'a', phrase: 'her heart ached', category: 'retired', alternatives: [], notes: '' }],
      auditLog: [],
    });
    provider.setImpl(writingImpl({ 'source/motif-ledger.json': ledger }));

    await generate([3]);

    expect(progress.some((e) => e.type === 'step-done')).toBe(true);
    const saved = JSON.parse(fs.files.get('test-book/source/motif-ledger.json')!);
    expect(saved.flaggedPhrases).toEqual([]);
    expect(saved.auditLog[0].notes).toContain('her heart ached');
    expect(saved.auditLog[0].notes).toContain('not bans');
  });

  it('a throwing provider reports step-error', async () => {
    provider.setImpl(async () => { throw new Error('model unavailable'); });

    await generate([0]);

    expect(progress).toContainEqual({ type: 'step-error', index: 0, message: 'model unavailable' });
  });

  it('disables thinking budgets when settings have thinking off', async () => {
    service = new SourceGenerationService(
      makeFakeSettings({ enableThinking: false }),
      makeFakeAgents(),
      db,
      fs,
      makeFakeRegistry(provider, { models: [makeModelInfo(DEFAULT_SETTINGS.model)] })
    );
    provider.setImpl(writingImpl());

    await generate();

    expect(provider.calls.every((c) => c.thinkingBudget === undefined)).toBe(true);
  });
});
