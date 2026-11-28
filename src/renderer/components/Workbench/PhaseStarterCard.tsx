import { AGENT_REGISTRY } from '@domain/constants';
import type { QuickAction } from '@domain/constants';
import type { PipelinePhase } from '@domain/types';
import { agentColor } from '../common/agentColors';

type PhaseStarterCardProps = {
  phase: PipelinePhase;
  /** Curated starting points (from getPhaseStarterActions). */
  starters: QuickAction[];
  /** Called with the full prompt — same effect as a Quick actions pick. */
  onPick: (prompt: string, label: string) => void;
  /** Shown only when no conversation exists yet: start one with an empty input. */
  onStartBlank?: () => void;
  disabled: boolean;
};

/**
 * Temporary call-to-action card that fills the chat pane on a fresh phase
 * (no conversation, or a conversation with no messages yet). Disappears as
 * soon as the first message lands.
 */
export function PhaseStarterCard({
  phase,
  starters,
  onPick,
  onStartBlank,
  disabled,
}: PhaseStarterCardProps): React.ReactElement {
  const role = phase.agent ? AGENT_REGISTRY[phase.agent]?.role : null;

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
      <div
        data-tour="phase-starter-card"
        className="w-full max-w-lg rounded-xl border border-ne-line bg-ne-bg1 px-6 py-5 shadow-sm"
      >
        <div className="font-ne-serif text-[17px] font-medium text-ne-ink">{phase.label}</div>
        {phase.agent && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ne-ink-dim">
            <span
              className="inline-block h-[7px] w-[7px] rounded-full"
              style={{ background: agentColor(phase.agent) }}
            />
            {phase.agent}
            {role ? ` — ${role}` : ''}
          </div>
        )}
        <p className="mt-3 text-sm text-ne-ink-dim">{phase.description}</p>

        <div className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-ne-ink-faint">
          Common starting points
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {starters.map((action) => (
            <button
              key={action.label}
              onClick={() => onPick(action.prompt, action.label)}
              disabled={disabled}
              title={action.prompt}
              className="rounded-[7px] border border-ne-line bg-ne-bg2 px-3 py-1.5 text-xs text-ne-ink transition-colors hover:border-ne-brass/60 hover:text-ne-brass-hi disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>

        {onStartBlank && (
          <button
            onClick={onStartBlank}
            disabled={disabled}
            className="mt-4 text-[11px] text-ne-ink-faint underline-offset-2 transition-colors hover:text-ne-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start a blank conversation
          </button>
        )}
      </div>
    </div>
  );
}
