import type { AppSettings, ProviderConfig } from '@domain/types';
import {
  CLAUDE_CLI_ALIAS_MODELS,
  CLAUDE_CLI_PROVIDER_ID,
  LEGACY_CLAUDE_CLI_MODEL_IDS,
} from '@domain/constants';

const ALIAS_IDS = new Set(CLAUDE_CLI_ALIAS_MODELS.map((m) => m.id));
const LEGACY_IDS = new Set(LEGACY_CLAUDE_CLI_MODEL_IDS);

function isLegacy(modelId: string | undefined): boolean {
  return modelId !== undefined && LEGACY_IDS.has(modelId);
}

/**
 * One-time migration from the dated Claude model IDs that earlier releases
 * shipped as built-ins to the Claude CLI aliases (`opus`, `sonnet`, `haiku`).
 *
 * Runs only when the saved claude-cli provider lists none of the aliases yet:
 * - Legacy built-in IDs are removed from the claude-cli model list and the
 *   aliases are prepended. Model IDs the user added by hand are kept as-is.
 * - `model`, `secondaryModel` and the provider's `defaultModel` move to
 *   `opus` / `sonnet` only if they still point at a legacy built-in ID.
 *   A model the user picked themselves is left alone.
 *
 * Pure: returns the input object unchanged (same reference) when nothing
 * needs migrating, so callers can skip the write.
 */
export function migrateClaudeModelAliases(settings: AppSettings): AppSettings {
  const providers = settings.providers ?? [];
  const claudeIndex = providers.findIndex((p) => p.id === CLAUDE_CLI_PROVIDER_ID);
  if (claudeIndex === -1) return settings;

  const claude = providers[claudeIndex];
  if (claude.models.some((m) => ALIAS_IDS.has(m.id))) return settings;

  const userModels = claude.models.filter((m) => !LEGACY_IDS.has(m.id));
  const migratedClaude: ProviderConfig = {
    ...claude,
    models: [...CLAUDE_CLI_ALIAS_MODELS, ...userModels],
    defaultModel: claude.defaultModel === undefined || isLegacy(claude.defaultModel)
      ? 'opus'
      : claude.defaultModel,
  };

  const migratedProviders = [...providers];
  migratedProviders[claudeIndex] = migratedClaude;

  return {
    ...settings,
    providers: migratedProviders,
    model: isLegacy(settings.model) ? 'opus' : settings.model,
    secondaryModel: isLegacy(settings.secondaryModel) ? 'sonnet' : settings.secondaryModel,
  };
}
