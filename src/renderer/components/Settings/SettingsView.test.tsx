import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import type { ModelInfo, ProviderId } from '@domain/types';
import { SettingsView } from './SettingsView';
import pkg from '../../../../package.json';
import { useSettingsStore } from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { useTourStore } from '../../stores/tourStore';
import { useViewStore } from '../../stores/viewStore';
import { renderApp, type StoreSeed } from '../../../test/renderWithState';
import { resetStoresBeforeEach } from '../../../test/resetStores';
import { makeAppSettings, type BridgeOverrides } from '../../../test/novelEngineMock';

resetStoresBeforeEach(useSettingsStore, useProviderStore, useTourStore, useViewStore);

function model(id: string, providerId: string): ModelInfo {
  return { id, label: id.toUpperCase(), description: '', providerId: providerId as ProviderId };
}

const MODELS = [model('model-a', 'prov-a'), model('model-b', 'prov-b')];

function renderSettings(opts: { bridge?: BridgeOverrides; stores?: StoreSeed } = {}) {
  return renderApp(<SettingsView />, {
    stores: [
      [useSettingsStore, { settings: makeAppSettings({ activeProviderId: 'prov-a' as ProviderId }) }],
      ...(opts.stores ?? []),
    ],
    bridge: {
      models: { getAvailable: vi.fn(async () => MODELS) },
      ...opts.bridge,
    },
  });
}

describe('SettingsView', () => {
  it('opens on the Writing tab and warns when no models are available', async () => {
    renderSettings({ bridge: { models: { getAvailable: vi.fn(async () => []) } } });

    expect(screen.getByText('Model Selection')).toBeInTheDocument();
    expect(await screen.findByText(/No models are available yet/)).toBeInTheDocument();
    // Other tabs' content is not mounted
    expect(screen.queryByText('Built-in CLI Status')).not.toBeInTheDocument();
  });

  it('offers an on-demand Fable check and never probes on its own', async () => {
    const { bridge } = renderSettings();
    const button = await screen.findByRole('button', { name: 'Check for Fable access' });
    expect(bridge.claudeCli.checkFableAccess).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(bridge.claudeCli.checkFableAccess).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.models.getAvailable).toHaveBeenCalledTimes(2));
  });

  it('hides the Fable check once Fable is listed', async () => {
    renderSettings({
      bridge: { models: { getAvailable: vi.fn(async () => [...MODELS, model('fable', 'claude-cli')]) } },
    });
    await screen.findAllByText('FABLE');
    expect(screen.queryByRole('button', { name: 'Check for Fable access' })).not.toBeInTheDocument();
  });

  it('selecting a primary model saves it and switches the active provider', async () => {
    const { bridge } = renderSettings();
    await screen.findAllByText('MODEL-B');

    // Primary section renders first
    fireEvent.click(screen.getAllByRole('button', { name: /MODEL-B/ })[0]);

    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ model: 'model-b' }),
    );
    await waitFor(() => expect(bridge.providers.setDefault).toHaveBeenCalledWith('prov-b'));
  });

  it('selecting a secondary model never switches the provider', async () => {
    const { bridge } = renderSettings();
    await screen.findAllByText('MODEL-B');

    // Second MODEL-B button lives in the secondary section
    fireEvent.click(screen.getAllByRole('button', { name: /MODEL-B/ })[1]);

    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ secondaryModel: 'model-b' }),
    );
    expect(bridge.providers.setDefault).not.toHaveBeenCalled();
  });

  it('toggles extended thinking and the thinking budget', async () => {
    const { bridge } = renderSettings();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show agent thinking' }));
    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ enableThinking: false }),
    );

    fireEvent.change(screen.getByRole('slider'), { target: { value: '2048' } });
    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ thinkingBudget: 2048 }),
    );
  });

  it('Providers tab shows CLI status rows and re-checks a CLI', async () => {
    const { bridge } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Providers/ }));

    expect(screen.getByText('Claude CLI')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument(); // hasClaudeCli: true
    expect(screen.getAllByText('Not connected')).toHaveLength(2); // codex + ollama

    // Row order: claude, codex, ollama
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-check' })[1]);
    await waitFor(() => expect(bridge.settings.detectCodexCli).toHaveBeenCalled());
  });

  it('Reading font: preset saves at once, custom name saves sanitised on blur', async () => {
    // Stateful settings bridge so the store reload after update sees the change.
    let stored = makeAppSettings({ activeProviderId: 'prov-a' as ProviderId });
    const { bridge } = renderSettings({
      bridge: {
        settings: {
          load: vi.fn(async () => stored),
          update: vi.fn(async (partial) => {
            stored = { ...stored, ...partial };
          }),
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));

    const select = screen.getByRole('combobox', { name: 'Reading font' });
    expect(select).toHaveValue('fraunces');
    fireEvent.change(select, { target: { value: 'sans' } });
    await waitFor(() => expect(bridge.settings.update).toHaveBeenCalledWith({ proseFont: 'sans' }));
    await waitFor(() =>
      expect(screen.getByTestId('prose-font-preview').style.fontFamily).toContain('Inter'),
    );
    expect(screen.queryByRole('textbox', { name: 'Custom font name' })).not.toBeInTheDocument();

    // The sample follows the prose font size
    expect(screen.getByTestId('prose-font-preview').style.fontSize).toBe('16.5px');
    fireEvent.click(screen.getByRole('button', { name: 'Increase prose font size' }));
    await waitFor(() =>
      expect(screen.getByTestId('prose-font-preview').style.fontSize).toBe('17.5px'),
    );

    fireEvent.change(select, { target: { value: 'custom' } });
    const input = await screen.findByRole('textbox', { name: 'Custom font name' });
    fireEvent.change(input, { target: { value: 'EB Garamond; color: red' } });
    expect(bridge.settings.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ proseFontCustom: expect.anything() }),
    );
    fireEvent.blur(input);
    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ proseFontCustom: 'EB Garamond color red' }),
    );
  });

  it('Appearance tab reflects the theme and saves changes', async () => {
    const { bridge } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));

    expect(screen.getByRole('radio', { name: /System/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Light/ }));
    await waitFor(() => expect(bridge.settings.update).toHaveBeenCalledWith({ theme: 'light' }));

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Show OS notifications when agents finish/ }),
    );
    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ enableNotifications: true }),
    );
  });

  it('Profile tab renders the author profile and saves the author name', async () => {
    const { bridge } = renderSettings({
      bridge: {
        settings: { loadAuthorProfile: vi.fn(async () => '# Voice\n\nGritty prose') },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));

    expect(await screen.findByText('Voice')).toBeInTheDocument();
    expect(screen.getByText('Gritty prose')).toBeInTheDocument();

    const nameInput = screen.getByDisplayValue('Test Author');
    fireEvent.change(nameInput, { target: { value: 'New Name' } });
    await waitFor(() =>
      expect(bridge.settings.update).toHaveBeenCalledWith({ authorName: 'New Name' }),
    );
  });

  it('saves a manually edited author profile', async () => {
    const { bridge } = renderSettings({
      bridge: { settings: { loadAuthorProfile: vi.fn(async () => 'Old profile') } },
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Manually' }));

    const textarea = screen.getByPlaceholderText(/What genres do you write/);
    fireEvent.change(textarea, { target: { value: 'New profile text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.settings.saveAuthorProfile).toHaveBeenCalledWith('New profile text'),
    );
    // Edit form closes after save
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/What genres do you write/)).not.toBeInTheDocument(),
    );
  });

  it('Profile tab shows empty usage and completed tours', async () => {
    const resetTour = vi.fn(async () => undefined);
    // startTour is stubbed too — the real one fires on a 300ms timer after replay
    renderSettings({
      stores: [[useTourStore, { completedTours: new Set(['welcome']), resetTour, startTour: vi.fn() }]],
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));

    expect(await screen.findByText('No usage data yet')).toBeInTheDocument();
    expect(screen.getByTitle('Tour completed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Welcome Tour' }));
    await waitFor(() => expect(resetTour).toHaveBeenCalledWith('welcome'));
    expect(useViewStore.getState().currentView).toBe('workspace');
  });

  it('Profile tab shows the data folder and changes it through the bridge', async () => {
    const { bridge } = renderSettings({
      bridge: {
        dataFolder: {
          get: vi.fn(async () => ({ current: '/data/ne', defaultDir: '/default', source: 'pointer' as const })),
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));

    expect(await screen.findByTestId('data-folder-path')).toHaveTextContent('/data/ne');
    expect(screen.getByText('Chosen in Settings')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => expect(bridge.dataFolder.change).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Use Default Folder' }));
    await waitFor(() => expect(bridge.dataFolder.reset).toHaveBeenCalled());
  });

  it('disables data folder changes while a startup override is active', async () => {
    renderSettings({
      bridge: {
        dataFolder: {
          get: vi.fn(async () => ({ current: '/env/ne', defaultDir: '/default', source: 'env' as const })),
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));

    expect(await screen.findByText(/NOVEL_ENGINE_DATA_DIR/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Use Default Folder' })).not.toBeInTheDocument();
  });

  it('About shows the product name, package version and links', async () => {
    const { bridge } = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));

    expect(await screen.findByText(`v${pkg.version}`, { exact: false })).toHaveTextContent(
      `Novel Engine Spur v${pkg.version}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(bridge.shell.openExternal).toHaveBeenCalledWith('https://github.com/Foozinator/novel-engine');
    fireEvent.click(screen.getByRole('button', { name: 'Original Novel Engine' }));
    expect(bridge.shell.openExternal).toHaveBeenCalledWith('https://github.com/john-paul-ruf/novel-engine');
  });

  it('lists updated and edited agent prompts', async () => {
    renderSettings({
      bridge: {
        agents: {
          promptSync: vi.fn(async () => ({
            updated: ['VERITY-LEDGER.md'],
            edited: ['SPARK.md', 'QUILL.md'],
            agentsDir: '/data/custom-agents',
          })),
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Profile/ }));

    expect(await screen.findByTestId('prompts-updated')).toHaveTextContent('VERITY-LEDGER.md');
    const edited = screen.getByTestId('prompts-edited');
    expect(edited).toHaveTextContent('SPARK.md');
    expect(edited).toHaveTextContent('QUILL.md');
  });
});
