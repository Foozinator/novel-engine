import type { GateKind } from '@domain/types';
import { REVISION_SESSION_COMPLETE_MARKER } from '@domain/constants';

/**
 * Revision-queue gate detection.
 *
 * The queue completes a session only when Verity's last non-empty line is
 * REVISION_SESSION_COMPLETE_MARKER and the paragraph before it asks nothing.
 * Every other ending is a gate. A wrong pause costs the author one click;
 * a wrong pass skips a decision the author was supposed to make.
 *
 * Gates are classified so the queue knows whether a quick reply ("Approved.
 * Continue…") can answer it (`confirm`) or only the author's typed answer can
 * (`choice`): lettered options, an "A or B?" question, or an open question
 * ("Which version do you prefer?").
 */

/** How many trailing paragraphs to scan for options. */
const TAIL_PARAGRAPHS = 3;

/**
 * A line that presents a lettered or named option: `A) …`, `(b) …`, `A. …`,
 * `**Option A** …`, `- Option 2: …`. Plain numbered lists are not counted:
 * Verity uses them for change reports, so they would turn every approval
 * stop into a choice.
 */
const OPTION_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:\(?[A-Ha-h][).:](?:\*\*|__)?\s|Option\s+(?:[A-Ha-h]|[1-9])\b)/;

/** A question sentence (text up to and including a `?`). */
const QUESTION_SENTENCE = /[^.?!\n]*\?/g;

/**
 * The alternative after " or " is a fallback offer, not a second option:
 * "Shall I proceed, or would you like changes?" is a yes/no stop.
 */
const FALLBACK_ALTERNATIVE =
  /\bor\s+(?:would you like|do you want|did you want|should i (?:make|adjust|change|tweak|revise|rework)|any\b|anything\b|something else|let me know|if\b|is there|are there|not\b|no\b)/i;

/**
 * An open question that "Approved." cannot answer: "Which version do you
 * prefer?", "Before I draft, what should the trim be?". Checked against the
 * whole question and against its last comma clause.
 */
const OPEN_QUESTION_START = /^\s*(?:\*\*|__)?(?:which|what|how|where|who|whom|when|why)\b/i;

/** Open questions that are really "does this pass?" and an approval answers. */
const REVIEW_QUESTION =
  /\b(?:how does (?:this|that|it|the \w+) (?:look|read|sound|feel)|what do you think|how(?:'s| is) (?:this|that))\b/i;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Response text with marker lines removed. */
export function stripCompletionMarker(response: string): string {
  return response
    .split('\n')
    .filter((line) => line.trim() !== REVISION_SESSION_COMPLETE_MARKER)
    .join('\n')
    .trim();
}

/** True when the session is finished: marker on the last line, no trailing question. */
export function isSessionComplete(response: string): boolean {
  const lines = response.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';
  if (lastLine !== REVISION_SESSION_COMPLETE_MARKER) return false;

  const paragraphs = splitParagraphs(stripCompletionMarker(response));
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? '';
  return !lastParagraph.includes('?');
}

function isOpenQuestion(question: string): boolean {
  if (REVIEW_QUESTION.test(question)) return false;
  const lastClause = question.split(/[,;:\u2014]/).pop() ?? question;
  return OPEN_QUESTION_START.test(question) || OPEN_QUESTION_START.test(lastClause);
}

/** A question the author must answer in words: real alternatives or an open question. */
function asksForAnswer(text: string): boolean {
  const questions = text.match(QUESTION_SENTENCE) ?? [];
  return questions.some(
    (q) => (/\bor\b/i.test(q) && !FALLBACK_ALTERNATIVE.test(q)) || isOpenQuestion(q),
  );
}

/** Classify a response the queue has decided is a gate. */
export function classifyGate(response: string): { kind: GateKind; gateText: string } {
  const paragraphs = splitParagraphs(stripCompletionMarker(response));
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? '';
  const tail = paragraphs.slice(-TAIL_PARAGRAPHS);

  // First tail paragraph that holds an option line; gate text starts there.
  let optionCount = 0;
  let firstOptionIdx = -1;
  tail.forEach((p, i) => {
    const n = p.split('\n').filter((line) => OPTION_LINE.test(line)).length;
    if (n > 0 && firstOptionIdx === -1) firstOptionIdx = i;
    optionCount += n;
  });

  if (optionCount >= 2) {
    return { kind: 'choice', gateText: tail.slice(firstOptionIdx).join('\n\n') };
  }

  const lastTwo = paragraphs.slice(-2).join('\n\n');
  if (asksForAnswer(lastTwo)) {
    return { kind: 'choice', gateText: lastParagraph };
  }

  return { kind: 'confirm', gateText: lastParagraph };
}
