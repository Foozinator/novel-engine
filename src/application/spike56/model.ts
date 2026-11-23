// THROWAWAY — spike #56 (iteration model). Proof code only; not for merge.
import type { AgentName, PipelinePhaseId } from '@domain/types';

/**
 * Phase TYPES: kinds of work. A type can run any number of times; each
 * execution is a RUN in the book's run log. Today's 15 phase IDs collapse to
 * 13 types (first/second read → read, first/second assessment → assessment)
 * plus `readiness` (#89). Types that already had a one-to-one phase ID keep it.
 */
export type PhaseType =
  | 'pitch'
  | 'scaffold'
  | 'draft'
  | 'read'
  | 'assessment'
  | 'revision-plan'
  | 'revision'
  | 'copy-edit'
  | 'fix-plan'
  | 'mechanical-fixes'
  | 'build'
  | 'publish'
  | 'query-agents'
  | 'readiness';

/**
 * How a run of this type becomes ready to confirm:
 * - `files`: its output files exist with substance and differ from the
 *   hashes recorded when the run started (no word-count comparisons).
 * - `action`: only an explicit author action completes it (Complete
 *   Revision, Draft Complete, Complete Fixes).
 */
export type Gate = 'files' | 'action';

export type PhaseTypeDef = {
  type: PhaseType;
  label: string;
  agent: AgentName | null;
  /** Live output paths. `{slug}` is replaced with the book's slug. */
  outputs: string[];
  gate: Gate;
  /** Substance threshold for `files` gates (default 50 words). */
  minWords?: number;
  /** A run of this type rewrites chapters: take a draft snapshot when it starts. */
  rewrites: boolean;
};

const PLAN = ['source/project-tasks.md', 'source/revision-prompts.md'];

export const PHASE_TYPES: Record<PhaseType, PhaseTypeDef> = {
  pitch:              { type: 'pitch',            label: 'Story Pitch',           agent: 'Spark',      outputs: ['source/pitch.md'],          gate: 'files',  rewrites: false },
  scaffold:           { type: 'scaffold',         label: 'Story Scaffold',        agent: 'Verity',     outputs: ['source/scene-outline.md'],  gate: 'files',  rewrites: false, minWords: 200 },
  draft:              { type: 'draft',            label: 'Draft',                 agent: 'Verity',     outputs: [],                           gate: 'action', rewrites: true },
  read:               { type: 'read',             label: 'Read',                  agent: 'Ghostlight', outputs: ['source/reader-report.md'],  gate: 'files',  rewrites: false },
  assessment:         { type: 'assessment',       label: 'Structural Assessment', agent: 'Lumen',      outputs: ['source/dev-report.md'],     gate: 'files',  rewrites: false },
  'revision-plan':    { type: 'revision-plan',    label: 'Revision Plan',         agent: 'Forge',      outputs: PLAN,                         gate: 'files',  rewrites: false },
  revision:           { type: 'revision',         label: 'Revision',              agent: 'Verity',     outputs: [],                           gate: 'action', rewrites: true },
  'copy-edit':        { type: 'copy-edit',        label: 'Copy Edit',             agent: 'Sable',      outputs: ['source/audit-report.md'],   gate: 'files',  rewrites: false },
  'fix-plan':         { type: 'fix-plan',         label: 'Fix Planning',          agent: 'Forge',      outputs: PLAN,                         gate: 'files',  rewrites: false },
  'mechanical-fixes': { type: 'mechanical-fixes', label: 'Mechanical Fixes',      agent: 'Verity',     outputs: [],                           gate: 'action', rewrites: true },
  build:              { type: 'build',            label: 'Build',                 agent: null,         outputs: ['dist/{slug}.md'],           gate: 'files',  rewrites: false, minWords: 1 },
  publish:            { type: 'publish',          label: 'Publish & Audit',       agent: 'Quill',      outputs: ['source/metadata.md'],       gate: 'files',  rewrites: false },
  'query-agents':     { type: 'query-agents',     label: 'Query Agents',          agent: 'Quill',      outputs: ['source/query-tracker.md'],  gate: 'files',  rewrites: false },
  readiness:          { type: 'readiness',        label: 'Readiness Check',       agent: 'Lumen',      outputs: ['source/readiness-report.md'], gate: 'files', rewrites: false },
};

export function outputsOf(type: PhaseType, slug: string): string[] {
  return PHASE_TYPES[type].outputs.map((p) => p.replace('{slug}', slug));
}

/**
 * PASS: a stretch of runs added together for one job. The default plan is
 * six passes whose 15 runs line up one-to-one with today's 15 phases.
 * "Iteration" is not a separate thing: Revision pass 3 is the third pass of
 * kind `revision`.
 */
export type PassKind = 'conceive' | 'draft' | 'assess' | 'revision' | 'copy-edit' | 'ship' | 'read' | 'readiness';

export const PASS_TEMPLATES: Record<PassKind, { label: string; phases: PhaseType[] }> = {
  conceive:    { label: 'Conceive',        phases: ['pitch', 'scaffold'] },
  draft:       { label: 'Draft',           phases: ['draft'] },
  assess:      { label: 'Assess',          phases: ['read', 'assessment'] },
  revision:    { label: 'Revision pass',   phases: ['revision-plan', 'revision', 'read', 'assessment'] },
  'copy-edit': { label: 'Copy edit pass',  phases: ['copy-edit', 'fix-plan', 'mechanical-fixes'] },
  ship:        { label: 'Ship',            phases: ['build', 'publish', 'query-agents'] },
  read:        { label: 'Read',            phases: ['read'] },
  readiness:   { label: 'Readiness check', phases: ['readiness'] },
};

/**
 * Follow-on runs suggested when the author adds a pass mid-book. The author
 * can drop any of them before confirming. A copy edit added after the build
 * changes nothing on its own, so it suggests a rebuild.
 */
export const ADD_PASS_FOLLOW_ONS: Partial<Record<PassKind, PhaseType[]>> = {
  'copy-edit': ['build'],
};

export const DEFAULT_PLAN: PassKind[] = ['conceive', 'draft', 'assess', 'revision', 'copy-edit', 'ship'];

/**
 * Legacy slot i (PIPELINE_PHASES[i]) ↔ run i of the default plan. Used by the
 * migration and to keep old conversations (pipeline_phase = legacy ID) attached
 * to the run that replaced their phase.
 */
export const LEGACY_SLOTS: { legacyPhase: PipelinePhaseId; type: PhaseType; passKind: PassKind; passIndex: number }[] =
  (() => {
    const ids: PipelinePhaseId[] = [
      'pitch', 'scaffold', 'first-draft', 'first-read', 'first-assessment',
      'revision-plan-1', 'revision', 'second-read', 'second-assessment',
      'copy-edit', 'revision-plan-2', 'mechanical-fixes', 'build', 'publish', 'query-agents',
    ];
    const slots: { legacyPhase: PipelinePhaseId; type: PhaseType; passKind: PassKind; passIndex: number }[] = [];
    DEFAULT_PLAN.forEach((kind, passIndex) => {
      for (const type of PASS_TEMPLATES[kind].phases) {
        slots.push({ legacyPhase: ids[slots.length], type, passKind: kind, passIndex });
      }
    });
    return slots;
  })();

/** Legacy phase ID → type, for conversations created before the migration. */
export const LEGACY_PHASE_TYPE: Record<PipelinePhaseId, PhaseType> = Object.fromEntries(
  LEGACY_SLOTS.map((s) => [s.legacyPhase, s.type]),
) as Record<PipelinePhaseId, PhaseType>;
