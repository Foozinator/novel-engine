import { useEffect } from 'react';
import { useCliUpdateStore } from '../../stores/cliUpdateStore';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ClaudeCliUpdateResult } from '@domain/types';
import { isVersionAtLeast } from '@domain/constants';
import type { CliUpdatePrompt } from '../../stores/cliUpdateStore';

const buttonClass =
  'shrink-0 rounded border border-ne-line px-2 py-0.5 text-[11px] text-ne-ink hover:bg-ne-bg2 disabled:opacity-50';
const primaryButtonClass =
  'shrink-0 rounded bg-ne-brass-dim px-2 py-0.5 text-[11px] font-medium text-ne-brass-hi hover:opacity-90 disabled:opacity-50';

function resultMessage(result: ClaudeCliUpdateResult, prompt: CliUpdatePrompt): string {
  const stillTooOld =
    prompt.kind === 'version-required' &&
    result.versionAfter !== null &&
    !isVersionAtLeast(result.versionAfter, prompt.requiredVersion);
  if (stillTooOld && (result.status === 'updated' || result.status === 'up-to-date')) {
    return `Claude CLI is now ${result.versionAfter}, but ${prompt.kind === 'version-required' ? prompt.requiredVersion : ''} or newer is required. Run \`${result.manualCommand}\` in a terminal, or update it with the package manager you installed it with.`;
  }
  switch (result.status) {
    case 'updated':
      return `Claude CLI updated: ${result.versionBefore ?? '?'} → ${result.versionAfter ?? '?'}.`;
    case 'up-to-date':
      return result.versionAfter
        ? `Claude CLI ${result.versionAfter} is up to date.`
        : 'The Claude CLI is up to date.';
    case 'busy':
      return 'An agent is still running. Wait for it to finish, then update.';
    case 'not-installed':
      return 'The Claude CLI was not found on this computer.';
    case 'failed':
      return `The update did not complete. Run \`${result.manualCommand}\` in a terminal. If you installed Claude Code with a package manager (npm, Homebrew, winget), update it with that tool instead.`;
  }
}

/** Resend the last user message of the conversation whose call failed, if it is still open. */
function retryChat(conversationId: string): boolean {
  const chat = useChatStore.getState();
  if (chat.activeConversation?.id !== conversationId || chat.isStreaming) return false;
  const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  void chat.sendMessage(lastUser.content);
  return true;
}

/**
 * Global banner for Claude CLI updates: shown when a call fails because the
 * installed CLI is too old for the model, and at most weekly at launch.
 * Mounted once in AppLayout; owns the stream listener and the reminder check.
 */
export function CliUpdateBanner(): React.ReactElement | null {
  const { prompt, running, result, initListener, destroyListener, checkReminder, runUpdate, dismiss } =
    useCliUpdateStore();
  const updateSettings = useSettingsStore((s) => s.update);

  useEffect(() => {
    initListener();
    void checkReminder();
    return () => destroyListener();
  }, [initListener, destroyListener, checkReminder]);

  if (!prompt) return null;

  const canRetry =
    prompt.kind === 'version-required' &&
    prompt.conversationId !== null &&
    (result?.status === 'updated' || result?.status === 'up-to-date') &&
    (result.versionAfter === null || isVersionAtLeast(result.versionAfter, prompt.requiredVersion));

  let message: string;
  if (running) {
    message = 'Updating the Claude CLI…';
  } else if (result) {
    message = resultMessage(result, prompt);
  } else if (prompt.kind === 'version-required') {
    message = `${prompt.currentVersion ? `Claude CLI ${prompt.currentVersion}` : 'The installed Claude CLI'} is too old for this model. Version ${prompt.requiredVersion} or newer is required.`;
  } else if (prompt.kind === 'reminder') {
    message = `Claude CLI ${prompt.version} is installed. Check for updates?`;
  } else {
    message = 'Checking for Claude CLI updates…';
  }

  return (
    <div
      role="status"
      className="shrink-0 border-t border-ne-line bg-ne-bg1 px-3 py-1.5 text-[11px] text-ne-ink-dim"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-ne-ink">{message}</span>

        {!running && !result && (
          <>
            <button className={primaryButtonClass} onClick={() => void runUpdate()}>
              {prompt.kind === 'reminder' ? 'Check for updates' : 'Update Claude CLI'}
            </button>
            {prompt.kind === 'reminder' && (
              <button
                className={buttonClass}
                onClick={() => {
                  void updateSettings({ claudeCliUpdateReminder: false });
                  dismiss();
                }}
              >
                Don&apos;t remind me
              </button>
            )}
          </>
        )}

        {!running && result?.status === 'busy' && (
          <button className={primaryButtonClass} onClick={() => void runUpdate()}>
            Try again
          </button>
        )}

        {!running && canRetry && prompt.kind === 'version-required' && prompt.conversationId && (
          <button
            className={primaryButtonClass}
            onClick={() => {
              const conversationId = prompt.conversationId;
              dismiss();
              if (conversationId) retryChat(conversationId);
            }}
          >
            Retry message
          </button>
        )}

        {!running && (
          <button className={buttonClass} onClick={dismiss}>
            {result ? 'Close' : 'Not now'}
          </button>
        )}
      </div>

      {result?.output && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ne-ink-faint">Output</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-ne-mono text-[10px] text-ne-ink-dim">
            {result.output}
          </pre>
        </details>
      )}
    </div>
  );
}
