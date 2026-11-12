import { describe, it, expect } from 'vitest';
import { REVISION_SESSION_COMPLETE_MARKER as DONE } from '@domain/constants';
import { classifyGate, isSessionComplete, stripCompletionMarker } from './revisionGate';

describe('isSessionComplete', () => {
  it('is true when the marker is the last line and nothing is asked', () => {
    expect(isSessionComplete(`All three tasks are revised.\n\n${DONE}`)).toBe(true);
    expect(isSessionComplete(`All tasks are done.\n${DONE}\n\n`)).toBe(true);
  });

  it('is false without the marker, whatever the wording', () => {
    expect(isSessionComplete('Revised the chapter as requested.\n\nAll tasks in this session are finished.')).toBe(false);
    expect(isSessionComplete('Task 1 revised.\n\nWhich version do you prefer?')).toBe(false);
    expect(isSessionComplete('')).toBe(false);
  });

  it('is false when the marker is not on the last line', () => {
    expect(isSessionComplete(`Done with task 1.\n\n${DONE}\n\nOne more thing about task 2.`)).toBe(false);
  });

  it('is false when the marker follows a question', () => {
    expect(isSessionComplete(`Should the epilogue stay?\n\n${DONE}`)).toBe(false);
    expect(isSessionComplete(`All done. Keep A or B?\n${DONE}`)).toBe(false);
  });
});

describe('stripCompletionMarker', () => {
  it('removes marker lines and trims', () => {
    expect(stripCompletionMarker(`Done.\n\n${DONE}\n`)).toBe('Done.');
  });
});

describe('classifyGate', () => {
  it('a yes/no approval stop is a confirm gate', () => {
    expect(classifyGate('Task 1 revised.\n\nShall I proceed with task 2?')).toEqual({
      kind: 'confirm',
      gateText: 'Shall I proceed with task 2?',
    });
  });

  it('a fallback "or would you like changes" is still a confirm gate', () => {
    expect(classifyGate('Task 1 revised.\n\nShall I proceed, or would you like any adjustments?').kind).toBe('confirm');
    expect(classifyGate('Ready for task 2, or do you want changes first?').kind).toBe('confirm');
  });

  it('a review question that an approval answers is a confirm gate', () => {
    expect(classifyGate('Revised passage above.\n\nHow does this read?').kind).toBe('confirm');
    expect(classifyGate('Revised passage above.\n\nWhat do you think?').kind).toBe('confirm');
  });

  it('a stop with no question (e.g. a turn-limit cutoff) is a confirm gate', () => {
    expect(classifyGate('Working through task 3 now; the ledger is updated.').kind).toBe('confirm');
    expect(classifyGate('')).toEqual({ kind: 'confirm', gateText: '' });
  });

  it('"A or B?" is a choice', () => {
    expect(classifyGate('Two ways to cut this.\n\nKeep the flashback or move it to chapter 4?').kind).toBe('choice');
    expect(classifyGate('Option A or B? And the trim?').kind).toBe('choice');
  });

  it('an open question is a choice', () => {
    expect(classifyGate('Both drafts are above.\n\nWhich version do you prefer?').kind).toBe('choice');
    expect(classifyGate('Before I draft, what should the new chapter title be?').kind).toBe('choice');
  });

  it('lettered options are a choice, and the gate text includes them', () => {
    const response = [
      'I see two ways to fix the pacing.',
      'A) Cut the market scene.\nB) Compress it to a paragraph.',
      'Let me know.',
    ].join('\n\n');
    expect(classifyGate(response)).toEqual({
      kind: 'choice',
      gateText: 'A) Cut the market scene.\nB) Compress it to a paragraph.\n\nLet me know.',
    });
  });

  it('bold "Option" headings are a choice', () => {
    const response = '**Option A** — keep the dream.\n\n**Option B** — cut it.\n\nYour call?';
    expect(classifyGate(response).kind).toBe('choice');
  });

  it('a numbered change report before an approval stop stays a confirm gate', () => {
    const response = [
      'Task 1 done. Changes:',
      '1. Tightened the opening.\n2. Cut the second flashback.\n3. Fixed the tense slip.',
      'Shall I proceed to task 2?',
    ].join('\n\n');
    expect(classifyGate(response).kind).toBe('confirm');
  });

  it('ignores the marker when classifying', () => {
    expect(classifyGate(`Keep A or B?\n\n${DONE}`)).toEqual({ kind: 'choice', gateText: 'Keep A or B?' });
  });
});
