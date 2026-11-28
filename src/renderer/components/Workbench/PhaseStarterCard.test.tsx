import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PipelinePhase } from '@domain/types';
import { getPhaseStarterActions } from '@domain/constants';
import { PhaseStarterCard } from './PhaseStarterCard';

const FIRST_ASSESSMENT: PipelinePhase = {
  id: 'first-assessment',
  label: 'Structural Assessment',
  agent: 'Lumen',
  status: 'active',
  description: 'Diagnose structural strengths and weaknesses',
};

describe('PhaseStarterCard', () => {
  const starters = getPhaseStarterActions('first-assessment', 'Lumen');

  it('shows the phase description, agent and one button per starter', () => {
    render(
      <PhaseStarterCard phase={FIRST_ASSESSMENT} starters={starters} onPick={vi.fn()} disabled={false} />,
    );

    expect(screen.getByText('Structural Assessment')).toBeInTheDocument();
    expect(screen.getByText(FIRST_ASSESSMENT.description)).toBeInTheDocument();
    expect(screen.getByText(/^Lumen/)).toBeInTheDocument();
    for (const action of starters) {
      expect(screen.getByRole('button', { name: action.label })).toBeInTheDocument();
    }
    // Granular passes are not offered on the card
    expect(screen.queryByRole('button', { name: 'Read first half' })).toBeNull();
  });

  it('calls onPick with the full prompt', () => {
    const onPick = vi.fn();
    render(<PhaseStarterCard phase={FIRST_ASSESSMENT} starters={starters} onPick={onPick} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Full assessment' }));
    expect(onPick).toHaveBeenCalledWith(starters[0].prompt, starters[0].label);
  });

  it('offers a blank start only when onStartBlank is given', () => {
    const onStartBlank = vi.fn();
    const { rerender } = render(
      <PhaseStarterCard phase={FIRST_ASSESSMENT} starters={starters} onPick={vi.fn()} disabled={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Start a blank conversation' })).toBeNull();

    rerender(
      <PhaseStarterCard
        phase={FIRST_ASSESSMENT}
        starters={starters}
        onPick={vi.fn()}
        onStartBlank={onStartBlank}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank conversation' }));
    expect(onStartBlank).toHaveBeenCalled();
  });

  it('disables the buttons when disabled', () => {
    render(<PhaseStarterCard phase={FIRST_ASSESSMENT} starters={starters} onPick={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Full assessment' })).toBeDisabled();
  });
});
