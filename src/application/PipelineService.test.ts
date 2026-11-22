import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineService } from './PipelineService';
import { makeFakeFs, type FakeFileSystem } from '../test/fakes';

const WORDS_60 = 'word '.repeat(60).trim();
const WORDS_250 = 'word '.repeat(250).trim();
const TINY = 'stub content here';

/** `n` copies of `word`, space-separated. */
const words = (n: number, word = 'word'): string => `${word} `.repeat(n).trim();

/** Every phase up to and including the first plan. */
const THROUGH_PLAN = ['pitch', 'scaffold', 'first-draft', 'first-read', 'first-assessment', 'revision-plan-1'];

let fs: FakeFileSystem;
let service: PipelineService;

/** A book whose first read, assessment and plan are on disk, with the given phases confirmed. */
function seedThroughPlan(confirmedPhases: string[] = THROUGH_PLAN): void {
  seed({
    'pipeline-state.json': JSON.stringify({ confirmedPhases }),
    'source/pitch.md': WORDS_60,
    'source/scene-outline.md': WORDS_250,
    'chapters/02-two/draft.md': words(1500),
    'source/reader-report.md': words(60, 'reader'),
    'source/dev-report.md': words(60, 'dev'),
    'source/project-tasks.md': words(60, 'task'),
    'source/revision-prompts.md': words(60, 'prompt'),
  });
  fs.meta.status = 'revision-1';
}

function seed(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    fs.files.set(`book/${path}`, content);
  }
}

function stateOnDisk(): string[] {
  const raw = fs.files.get('book/pipeline-state.json');
  return raw ? (JSON.parse(raw) as { confirmedPhases: string[] }).confirmedPhases : [];
}

async function statusOf(phaseId: string): Promise<string> {
  const phases = await service.detectPhases('book');
  return phases.find((p) => p.id === phaseId)?.status ?? 'missing';
}

beforeEach(() => {
  fs = makeFakeFs({}, { bookSlug: 'book' });
  service = new PipelineService(fs);
});

describe('detectPhases', () => {
  it('a fresh book starts at pitch=active with all later phases locked, creating the state file', async () => {
    const phases = await service.detectPhases('book');

    expect(phases[0]).toMatchObject({ id: 'pitch', status: 'active' });
    expect(phases.slice(1).every((p) => p.status === 'locked')).toBe(true);
    expect(stateOnDisk()).toEqual([]); // state file auto-created
  });

  it('legacy books auto-confirm every file-complete phase on first run', async () => {
    seed({ 'source/pitch.md': WORDS_60, 'source/scene-outline.md': WORDS_250 });

    const phases = await service.detectPhases('book');

    expect(phases[0].status).toBe('complete'); // pitch
    expect(phases[1].status).toBe('complete'); // scaffold
    expect(phases[2].status).toBe('active'); // first-draft
    expect(stateOnDisk()).toEqual(['pitch', 'scaffold']);
  });

  it('file-complete but unconfirmed phases show pending-completion', async () => {
    seed({ 'pipeline-state.json': JSON.stringify({ confirmedPhases: [] }), 'source/pitch.md': WORDS_60 });

    expect(await statusOf('pitch')).toBe('pending-completion');
    expect(await statusOf('scaffold')).toBe('locked');
  });

  it('placeholder stubs below the word thresholds do not complete phases', async () => {
    seed({
      'pipeline-state.json': JSON.stringify({ confirmedPhases: [] }),
      'source/pitch.md': TINY, // < 50 words
    });
    expect(await statusOf('pitch')).toBe('active');

    seed({ 'source/pitch.md': WORDS_60, 'source/scene-outline.md': WORDS_60 }); // outline < 200
    await service.confirmPhaseAdvancement('book', 'pitch');
    expect(await statusOf('scaffold')).toBe('active');

    seed({ 'source/scene-outline.md': WORDS_250 });
    expect(await statusOf('scaffold')).toBe('pending-completion');
  });

  it('first-draft requires >1000 chapter words AND an advanced book status', async () => {
    seed({
      'pipeline-state.json': JSON.stringify({ confirmedPhases: ['pitch', 'scaffold'] }),
      'source/pitch.md': WORDS_60,
      'source/scene-outline.md': WORDS_250,
      'chapters/02-two/draft.md': 'word '.repeat(1500).trim(),
    });
    fs.meta.status = 'first-draft';
    expect(await statusOf('first-draft')).toBe('active');

    fs.meta.status = 'revision-1';
    expect(await statusOf('first-draft')).toBe('pending-completion');
  });

  it('second-read demands a live report that differs from the newest archive', async () => {
    seedThroughPlan([...THROUGH_PLAN, 'revision']);
    seed({
      'source/reader-report-v1.md': words(90, 'reader'), // an older read
      'source/reader-report-v2.md': words(60, 'reader'), // identical word count → not a new read
    });

    expect(await statusOf('second-read')).toBe('active');

    seed({ 'source/reader-report.md': WORDS_250 }); // fresh second read
    expect(await statusOf('second-read')).toBe('pending-completion');
  });

  it('revision is action-gated: an earlier reader archive never offers to advance it (#81)', async () => {
    seedThroughPlan();
    seed({ 'source/reader-report-v1.md': words(90, 'reader') }); // e.g. a first read that was run twice

    expect(await statusOf('revision')).toBe('active');

    await service.completeRevision('book');
    expect(await statusOf('revision')).toBe('complete');
  });

  it('revision-plan-1 stays complete while a Forge run has moved the plan into the archive (#81)', async () => {
    seedThroughPlan();
    fs.files.delete('book/source/project-tasks.md');
    fs.files.delete('book/source/revision-prompts.md');
    seed({ 'source/project-tasks-v1.md': words(60, 'task'), 'source/revision-prompts-v1.md': words(60, 'prompt') });

    expect(await statusOf('revision-plan-1')).toBe('complete');
    expect(await statusOf('revision')).toBe('active');
  });

  it('Fix Planning needs a plan that differs from the newest archived plan (#81)', async () => {
    seedThroughPlan([...THROUGH_PLAN, 'revision', 'second-read', 'second-assessment', 'copy-edit']);
    seed({
      'source/reader-report-v1.md': words(90, 'reader'),
      'source/dev-report-v1.md': words(90, 'dev'),
      'source/audit-report.md': WORDS_60,
      // Complete Revision copied the plan the revision ran
      'source/project-tasks-v1.md': words(60, 'task'),
      'source/revision-prompts-v1.md': words(60, 'prompt'),
    });

    expect(await statusOf('revision-plan-2')).toBe('active');

    seed({ 'source/project-tasks.md': words(80, 'fix'), 'source/revision-prompts.md': words(80, 'fix') });
    expect(await statusOf('revision-plan-2')).toBe('pending-completion');

    // An archive holding only the task list (the old agent rule) is judged on the task list
    fs.files.delete('book/source/revision-prompts-v1.md');
    expect(await statusOf('revision-plan-2')).toBe('pending-completion');
  });

  it('getActivePhase returns the attention phase; getAgentForPhase maps agents with build → null', async () => {
    seed({ 'pipeline-state.json': JSON.stringify({ confirmedPhases: [] }), 'source/pitch.md': WORDS_60 });

    expect((await service.getActivePhase('book'))?.id).toBe('pitch');
    expect(service.getAgentForPhase('pitch')).toBe('Spark');
    expect(service.getAgentForPhase('build')).toBeNull();
  });
});

describe('confirmation flow', () => {
  it('confirmPhaseAdvancement promotes the phase and unlocks the next, idempotently', async () => {
    seed({ 'pipeline-state.json': JSON.stringify({ confirmedPhases: [] }), 'source/pitch.md': WORDS_60 });

    await service.confirmPhaseAdvancement('book', 'pitch');
    expect(await statusOf('pitch')).toBe('complete');
    expect(await statusOf('scaffold')).toBe('active');

    await service.confirmPhaseAdvancement('book', 'pitch');
    expect(stateOnDisk()).toEqual(['pitch']); // no duplicates
  });

  it('markPhaseComplete writes a stub that passes every threshold and auto-confirms', async () => {
    seed({ 'pipeline-state.json': JSON.stringify({ confirmedPhases: [] }) });

    await service.markPhaseComplete('book', 'pitch');

    expect(await statusOf('pitch')).toBe('complete');
    const stub = fs.files.get('book/source/pitch.md') ?? '';
    expect(stub).toContain('Manual Advancement Notice');
    expect(stub.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(200);

    // Existing content is never replaced by the stub
    seed({ 'source/scene-outline.md': 'authored outline content' });
    await service.markPhaseComplete('book', 'scaffold');
    expect(fs.files.get('book/source/scene-outline.md')).toBe('authored outline content');
  });

  it('markPhaseComplete advances status-based phases via book meta', async () => {
    await service.markPhaseComplete('book', 'first-draft');
    expect(fs.meta.status).toBe('revision-1');

    await service.markPhaseComplete('book', 'mechanical-fixes');
    expect(fs.meta.status).toBe('final');
    expect(stateOnDisk()).toEqual(expect.arrayContaining(['first-draft', 'mechanical-fixes']));
  });

  it('completeRevision archives the reports and the plan to v1 and confirms the revision phase', async () => {
    seed({
      'source/reader-report.md': 'reader findings',
      'source/dev-report.md': 'dev findings',
      'source/project-tasks.md': 'tasks',
      'source/revision-prompts.md': 'prompts',
    });

    await service.completeRevision('book');

    expect(fs.files.get('book/source/reader-report-v1.md')).toBe('reader findings');
    expect(fs.files.get('book/source/dev-report-v1.md')).toBe('dev findings');
    expect(fs.files.get('book/source/project-tasks-v1.md')).toBe('tasks');
    expect(fs.files.get('book/source/revision-prompts-v1.md')).toBe('prompts');
    expect(fs.files.get('book/source/reader-report.md')).toBe('reader findings'); // live reports stay
    expect(stateOnDisk()).toContain('revision');
  });

  it('completing the revision three times keeps every earlier report and plan (#81)', async () => {
    seedThroughPlan();

    // Revision 1
    await service.completeRevision('book');

    // Second read and assessment, then the revision is redone
    seed({ 'source/reader-report.md': 'reader two', 'source/dev-report.md': 'dev two' });
    await service.revertPhase('book', 'revision');
    await service.completeRevision('book');

    // A third read, assessment and plan, then the revision is redone again
    seed({
      'source/reader-report.md': 'reader three',
      'source/dev-report.md': 'dev three',
      'source/project-tasks.md': 'tasks two',
      'source/revision-prompts.md': 'prompts two',
    });
    await service.revertPhase('book', 'revision');
    await service.completeRevision('book');

    expect([1, 2, 3].map((v) => fs.files.get(`book/source/reader-report-v${v}.md`))).toEqual([
      words(60, 'reader'),
      'reader two',
      'reader three',
    ]);
    expect([1, 2, 3].map((v) => fs.files.get(`book/source/dev-report-v${v}.md`))).toEqual([
      words(60, 'dev'),
      'dev two',
      'dev three',
    ]);
    // The plan was unchanged for the second revision, so it has two versions
    expect(fs.files.get('book/source/project-tasks-v1.md')).toBe(words(60, 'task'));
    expect(fs.files.get('book/source/project-tasks-v2.md')).toBe('tasks two');
    expect(fs.files.get('book/source/revision-prompts-v2.md')).toBe('prompts two');
    expect(fs.files.has('book/source/project-tasks-v3.md')).toBe(false);
    expect(stateOnDisk()).toContain('revision');
  });

  it('completeRevision adds no archive for unchanged reports and needs a reader report', async () => {
    seed({ 'source/reader-report.md': 'reader findings' });

    await service.completeRevision('book');
    await service.completeRevision('book');

    expect(fs.files.has('book/source/reader-report-v1.md')).toBe(true);
    expect(fs.files.has('book/source/reader-report-v2.md')).toBe(false);
    expect(fs.files.has('book/source/dev-report-v1.md')).toBe(false); // no dev report to archive

    fs.files.delete('book/source/reader-report.md');
    await expect(service.completeRevision('book')).rejects.toThrow(/reader-report\.md does not exist/);
  });
});

describe('revertPhase', () => {
  it('drops confirmation for the phase and everything after it', async () => {
    seed({
      'pipeline-state.json': JSON.stringify({ confirmedPhases: ['pitch', 'scaffold', 'first-draft'] }),
    });

    await service.revertPhase('book', 'scaffold');

    expect(stateOnDisk()).toEqual(['pitch']);
  });

  it('reverting revision keeps every archive and makes revision active again (#81); unknown phases throw', async () => {
    seedThroughPlan([...THROUGH_PLAN, 'revision']);
    seed({
      'source/reader-report-v1.md': 'archived read',
      'source/dev-report-v1.md': 'archived assessment',
      'source/project-tasks-v1.md': 'archived plan',
    });

    await service.revertPhase('book', 'revision');

    expect(fs.files.get('book/source/reader-report-v1.md')).toBe('archived read');
    expect(fs.files.get('book/source/dev-report-v1.md')).toBe('archived assessment');
    expect(fs.files.get('book/source/project-tasks-v1.md')).toBe('archived plan');
    expect(stateOnDisk()).toEqual(THROUGH_PLAN);
    expect(await statusOf('revision')).toBe('active'); // not "ready to advance"

    await expect(service.revertPhase('book', 'not-a-phase' as never)).rejects.toThrow(/Unknown pipeline phase/);
  });

  it('reverting first-draft rolls the book status back', async () => {
    fs.meta.status = 'revision-1';
    seed({ 'pipeline-state.json': JSON.stringify({ confirmedPhases: ['first-draft'] }) });

    await service.revertPhase('book', 'first-draft');

    expect(fs.meta.status).toBe('first-draft');
    expect(stateOnDisk()).toEqual([]);
  });
});
