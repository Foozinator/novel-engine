import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportChoiceModal } from './ImportChoiceModal';

function setup() {
  const onClose = vi.fn();
  const onImportBook = vi.fn();
  const onImportSeries = vi.fn();
  const onImportFromDataFolder = vi.fn();
  render(
    <ImportChoiceModal
      onClose={onClose}
      onImportBook={onImportBook}
      onImportSeries={onImportSeries}
      onImportFromDataFolder={onImportFromDataFolder}
    />,
  );
  return { onClose, onImportBook, onImportSeries, onImportFromDataFolder };
}

describe('ImportChoiceModal', () => {
  it('offers both import choices', () => {
    setup();
    expect(screen.getByRole('button', { name: /Single Book/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Series/ })).toBeInTheDocument();
  });

  it('Single Book fires onImportBook and closes', () => {
    const { onClose, onImportBook, onImportSeries } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Single Book/ }));
    expect(onImportBook).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onImportSeries).not.toHaveBeenCalled();
  });

  it('Series fires onImportSeries and closes', () => {
    const { onClose, onImportBook, onImportSeries } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Series/ }));
    expect(onImportSeries).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onImportBook).not.toHaveBeenCalled();
  });

  it('From another folder fires onImportFromDataFolder and closes', () => {
    const { onClose, onImportBook, onImportSeries, onImportFromDataFolder } = setup();
    fireEvent.click(screen.getByRole('button', { name: /another Novel Engine folder/ }));
    expect(onImportFromDataFolder).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onImportBook).not.toHaveBeenCalled();
    expect(onImportSeries).not.toHaveBeenCalled();
  });

  it('Cancel only closes', () => {
    const { onClose, onImportBook, onImportSeries } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onImportBook).not.toHaveBeenCalled();
    expect(onImportSeries).not.toHaveBeenCalled();
  });
});
