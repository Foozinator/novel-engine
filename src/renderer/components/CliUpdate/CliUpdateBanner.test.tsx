import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { CliUpdateBanner } from './CliUpdateBanner';
import { useCliUpdateStore } from '../../stores/cliUpdateStore';
import { useChatStore } from '../../stores/chatStore';
import { renderApp } from '../../../test/renderWithState';
import { resetStoresBeforeEach } from '../../../test/resetStores';

resetStoresBeforeEach(useCliUpdateStore, useChatStore);

afterEach(() => {
  useCliUpdateStore.getState().destroyListener();
});

const VERSION_ERROR =
  'Claude CLI run failed: API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required.';

function emitVersionError(bridge: ReturnType<typeof renderApp>['bridge'], conversationId = 'conv-1'): void {
  act(() => bridge.emit('chat:streamEvent', { type: 'error', message: VERSION_ERROR, source: 'chat', conversationId }));
}

describe('CliUpdateBanner', () => {
  it('renders nothing until there is something to say', () => {
    renderApp(<CliUpdateBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains a version-required error and updates the CLI on request', async () => {
    const { bridge } = renderApp(<CliUpdateBanner />);
    bridge.claudeCli.runUpdate.mockResolvedValueOnce({
      status: 'updated',
      output: 'Updated to 2.1.318',
      versionBefore: '2.1.220',
      versionAfter: '2.1.318',
      manualCommand: 'claude update',
    });
    emitVersionError(bridge);

    expect(screen.getByText(/Claude CLI 2\.1\.220 is too old for this model\. Version 2\.1\.280 or newer is required\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Claude CLI' }));

    expect(await screen.findByText('Claude CLI updated: 2.1.220 → 2.1.318.')).toBeInTheDocument();
    expect(screen.getByText('Updated to 2.1.318')).toBeInTheDocument(); // output
  });

  it('offers to retry the failed chat message after a successful update', async () => {
    const { bridge } = renderApp(<CliUpdateBanner />, {
      stores: [
        [
          useChatStore,
          {
            activeConversation: { id: 'conv-1', agentName: 'Spark' },
            messages: [{ id: 'm1', role: 'user', content: 'Write the pitch.', thinking: '', conversationId: 'conv-1', timestamp: '' }],
            isStreaming: false,
          },
        ],
      ],
    });
    bridge.claudeCli.runUpdate.mockResolvedValueOnce({
      status: 'updated',
      output: '',
      versionBefore: '2.1.220',
      versionAfter: '2.1.318',
      manualCommand: 'claude update',
    });
    emitVersionError(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Update Claude CLI' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry message' }));

    await waitFor(() => expect(bridge.chat.send).toHaveBeenCalledWith(expect.objectContaining({ message: 'Write the pitch.', conversationId: 'conv-1' })));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says so, with the manual command and no retry, when the CLI is still too old after updating', async () => {
    const { bridge } = renderApp(<CliUpdateBanner />);
    bridge.claudeCli.runUpdate.mockResolvedValueOnce({
      status: 'up-to-date',
      output: '',
      versionBefore: '2.1.220',
      versionAfter: '2.1.220',
      manualCommand: 'claude update',
    });
    emitVersionError(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Update Claude CLI' }));

    expect(await screen.findByText(/Claude CLI is now 2\.1\.220, but 2\.1\.280 or newer is required\. Run `claude update`/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
  });

  it('shows the weekly reminder at mount and can turn it off', async () => {
    const { bridge } = renderApp(<CliUpdateBanner />, {
      bridge: { claudeCli: { checkUpdateReminder: async () => ({ due: true, version: '2.1.318' }) } },
    });

    expect(await screen.findByText('Claude CLI 2.1.318 is installed. Check for updates?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't remind me" }));

    expect(bridge.settings.update).toHaveBeenCalledWith({ claudeCliUpdateReminder: false });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a busy result offers to try again', async () => {
    const { bridge } = renderApp(<CliUpdateBanner />);
    bridge.claudeCli.runUpdate.mockResolvedValueOnce({
      status: 'busy',
      output: '',
      versionBefore: '2.1.220',
      versionAfter: '2.1.220',
      manualCommand: 'claude update',
    });
    emitVersionError(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Update Claude CLI' }));

    expect(await screen.findByText('An agent is still running. Wait for it to finish, then update.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.claudeCli.runUpdate).toHaveBeenCalledTimes(2));
  });
});
