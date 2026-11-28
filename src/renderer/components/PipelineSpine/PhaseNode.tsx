import type { PipelinePhase } from '@domain/types';
import { agentColor } from '../common/agentColors';
import { Icon } from '../common/Icon';

type SpineState = 'done' | 'current' | 'locked';

function spineState(phase: PipelinePhase): SpineState {
  if (phase.status === 'complete') return 'done';
  if (phase.status === 'locked') return 'locked';
  return 'current'; // 'active' | 'pending-completion'
}

const LINE_CLASS: Record<SpineState, string> = {
  done: 'bg-ne-brass/30',
  current: 'bg-gradient-to-b from-ne-brass/60 to-ne-bg3',
  locked: 'bg-ne-bg3',
};

const NAME_CLASS: Record<SpineState, string> = {
  done: 'text-ne-ink',
  current: 'text-ne-ink-dim',
  locked: 'text-ne-ink-faint',
};

type PhaseNodeProps = {
  phase: PipelinePhase;
  isSelected: boolean;
  onSelect: () => void;
};

/** Hover text shared by the full row and the collapsed rail's dot. */
function phaseTitle(phase: PipelinePhase): string {
  if (phase.status === 'locked') {
    return `${phase.label} — locked. Complete the previous phase first.`;
  }
  if (phase.status === 'pending-completion') {
    return `${phase.label} — agent finished. Confirm & advance when you're ready.`;
  }
  return phase.description;
}

/** The round node on the spine line: check when done, pulsing when current, hollow when locked. */
function NodeMark({ phase, className }: { phase: PipelinePhase; className: string }): React.ReactElement {
  const state = spineState(phase);
  const isPending = phase.status === 'pending-completion';

  return (
    <span
      className={`${className} z-[1] grid h-4 w-4 place-items-center rounded-full ring-[3px] ring-ne-bg1 ${
        state === 'done'
          ? 'bg-ne-brass'
          : state === 'current'
          ? isPending
            ? 'bg-ne-spark'
            : 'bg-ne-brass-hi'
          : 'border-2 border-ne-bg3 bg-ne-bg1'
      }`}
    >
      {state === 'current' && (
        <span
          className={`absolute -inset-1 animate-pulse rounded-full blur-[3px] ${
            isPending ? 'bg-ne-spark/40' : 'bg-ne-brass-hi/40'
          }`}
        />
      )}
      {state === 'done' && (
        <Icon name="check" size={9} strokeWidth={3.4} className="relative text-ne-bg1" />
      )}
    </span>
  );
}

/**
 * One phase on the collapsed spine rail: the node alone, named by its
 * hover text. Selecting works as on the full row.
 */
export function PhaseDot({ phase, isSelected, onSelect }: PhaseNodeProps): React.ReactElement {
  const state = spineState(phase);

  return (
    <button
      onClick={onSelect}
      data-tour={`pipeline-phase-${phase.id}`}
      aria-label={phase.label}
      title={`${phase.label}${phase.agent ? ` · ${phase.agent}` : ''}\n${phaseTitle(phase)}`}
      className={`relative flex h-[26px] w-full items-center justify-center transition-colors ${
        isSelected ? 'bg-ne-brass-dim' : 'hover:bg-ne-ink/5'
      }`}
    >
      <span className={`absolute bottom-0 left-1/2 top-0 w-[2px] -translate-x-1/2 ${LINE_CLASS[state]}`} />
      <NodeMark phase={phase} className="relative" />
    </button>
  );
}

/**
 * One row of the illuminated spine: line segment + node + phase name + agent chip.
 * Every phase is selectable — locked phases show their locked workbench state (S08).
 */
export function PhaseNode({ phase, isSelected, onSelect }: PhaseNodeProps): React.ReactElement {
  const state = spineState(phase);

  return (
    <button
      onClick={onSelect}
      data-tour={`pipeline-phase-${phase.id}`}
      title={phaseTitle(phase)}
      className={`relative flex w-full items-center gap-2.5 py-[7px] pl-[52px] pr-3.5 text-left transition-colors ${
        isSelected ? 'bg-ne-brass-dim' : 'hover:bg-ne-ink/5'
      }`}
    >
      {/* Spine line segment */}
      <span className={`absolute bottom-0 left-[29px] top-0 w-[2px] ${LINE_CLASS[state]}`} />

      {/* Node */}
      <NodeMark phase={phase} className="absolute left-[22px]" />

      {/* Phase name */}
      <span
        className={`flex-1 text-[12.5px] font-medium leading-tight ${
          isSelected ? 'text-ne-brass-hi' : NAME_CLASS[state]
        }`}
      >
        {phase.label}
      </span>

      {/* Agent chip */}
      {phase.agent && (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-ne-ink-faint">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: agentColor(phase.agent) }}
          />
          {phase.agent}
        </span>
      )}
    </button>
  );
}
