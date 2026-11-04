import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelInfo, ProviderConfig } from '@domain/types';
import { BUILT_IN_PROVIDER_CONFIGS, CLAUDE_CLI_PROVIDER_ID, DEFAULT_SETTINGS } from '@domain/constants';
import { migrateClaudeModelAliases } from './claudeModelMigration';

function model(id: string, providerId = CLAUDE_CLI_PROVIDER_ID): ModelInfo {
  return { id, label: id, description: '', providerId, supportsThinking: true, supportsToolUse: true };
}

/** Settings as saved by a release that shipped dated Claude model IDs. */
function legacySettings(
  claudeModels: string[],
  overrides: Partial<AppSettings> = {},
  defaultModel = 'claude-opus-4-20250514',
): AppSettings {
  const claude: ProviderConfig = {
    ...BUILT_IN_PROVIDER_CONFIGS[0],
    models: claudeModels.map((id) => model(id)),
    defaultModel,
  };
  return {
    ...DEFAULT_SETTINGS,
    model: 'claude-opus-4-20250514',
    secondaryModel: 'claude-sonnet-4-20250514',
    providers: [claude, ...BUILT_IN_PROVIDER_CONFIGS.slice(1)],
    ...overrides,
  };
}

function claudeIds(settings: AppSettings): string[] {
  return settings.providers.find((p) => p.id === CLAUDE_CLI_PROVIDER_ID)!.models.map((m) => m.id);
}

describe('migrateClaudeModelAliases', () => {
  it('replaces the old built-in IDs with aliases and moves primary/secondary to opus/sonnet', () => {
    const result = migrateClaudeModelAliases(
      legacySettings(['claude-opus-4-20250514', 'claude-sonnet-4-20250514']),
    );

    expect(claudeIds(result)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(result.model).toBe('opus');
    expect(result.secondaryModel).toBe('sonnet');
    expect(result.providers[0].defaultModel).toBe('opus');
  });

  it('drops a previously probed claude-fable-5 entry (the probe re-adds `fable`)', () => {
    const result = migrateClaudeModelAliases(
      legacySettings(['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-fable-5']),
    );
    expect(claudeIds(result)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('keeps model IDs the user added and leaves a user-chosen primary model alone', () => {
    const result = migrateClaudeModelAliases(
      legacySettings(
        ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-opus-5-5'],
        { model: 'claude-opus-5-5' },
        'claude-opus-5-5',
      ),
    );

    expect(claudeIds(result)).toEqual(['opus', 'sonnet', 'haiku', 'claude-opus-5-5']);
    expect(result.model).toBe('claude-opus-5-5');
    expect(result.providers[0].defaultModel).toBe('claude-opus-5-5');
    // Secondary still pointed at a legacy built-in, so it moves.
    expect(result.secondaryModel).toBe('sonnet');
  });

  it('leaves a non-Claude primary model (e.g. an Ollama model) alone', () => {
    const result = migrateClaudeModelAliases(
      legacySettings(['claude-opus-4-20250514', 'claude-sonnet-4-20250514'], {
        model: 'llama3.2',
        activeProviderId: 'ollama-cli',
      }),
    );
    expect(result.model).toBe('llama3.2');
    expect(claudeIds(result)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('is a no-op (same reference) once any alias is present', () => {
    const already = legacySettings(['opus', 'sonnet', 'claude-opus-4-20250514']);
    expect(migrateClaudeModelAliases(already)).toBe(already);
    expect(migrateClaudeModelAliases(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS);
  });

  it('is a no-op when there is no claude-cli provider', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, providers: BUILT_IN_PROVIDER_CONFIGS.slice(1) };
    expect(migrateClaudeModelAliases(settings)).toBe(settings);
  });

  it('is idempotent', () => {
    const once = migrateClaudeModelAliases(legacySettings(['claude-opus-4-20250514']));
    expect(migrateClaudeModelAliases(once)).toBe(once);
  });

  it('does not mutate its input', () => {
    const input = legacySettings(['claude-opus-4-20250514', 'claude-sonnet-4-20250514']);
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateClaudeModelAliases(input);
    expect(input).toEqual(snapshot);
  });
});
