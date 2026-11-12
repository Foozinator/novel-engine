import { describe, expect, it, vi } from 'vitest';
import type { IFableProbe, IProviderRegistry, ISettingsService } from '@domain/interfaces';
import type { AppSettings, FableProbeStatus, ModelInfo, ProviderConfig } from '@domain/types';
import { CLAUDE_CLI_PROVIDER_ID, DEFAULT_SETTINGS, FABLE_MODEL_ID, FABLE_MODEL_INFO } from '@domain/constants';
import { FableAccessService } from './FableAccessService';

const NOW = new Date('2026-11-12T12:00:00.000Z');

function makeSettings(): ISettingsService & { current: AppSettings } {
  const store = {
    current: { ...DEFAULT_SETTINGS, hasClaudeCli: true },
    load: vi.fn(async () => store.current),
    update: vi.fn(async (partial: Partial<AppSettings>) => {
      store.current = { ...store.current, ...partial };
    }),
  };
  return store as unknown as ISettingsService & { current: AppSettings };
}

function makeProbe(status: FableProbeStatus, detail?: string): IFableProbe {
  return { probe: vi.fn(async () => ({ status, detail })) };
}

function makeRegistry(models: ModelInfo[]): IProviderRegistry & { config: ProviderConfig } {
  const registry = {
    config: { id: CLAUDE_CLI_PROVIDER_ID, models } as ProviderConfig,
    getProviderConfig: vi.fn((id: string) => (id === CLAUDE_CLI_PROVIDER_ID ? registry.config : null)),
    updateProviderConfig: vi.fn((_id: string, partial: Partial<ProviderConfig>) => {
      registry.config = { ...registry.config, ...partial };
    }),
  };
  return registry as unknown as IProviderRegistry & { config: ProviderConfig };
}

const OPUS: ModelInfo = { id: 'opus', label: 'Opus', description: '', providerId: CLAUDE_CLI_PROVIDER_ID };

describe('FableAccessService.check', () => {
  it('records an available result and adds Fable to the Claude CLI models', async () => {
    const settings = makeSettings();
    const registry = makeRegistry([OPUS]);
    const result = await new FableAccessService(settings, makeProbe('available'), registry, () => NOW).check();

    expect(result).toEqual({ status: 'available', detail: undefined, checkedAt: NOW.toISOString() });
    expect(settings.current.lastFableProbe).toEqual(result);
    expect(registry.config.models).toEqual([OPUS, FABLE_MODEL_INFO]);
  });

  it('does not add Fable twice', async () => {
    const registry = makeRegistry([OPUS, FABLE_MODEL_INFO]);
    await new FableAccessService(makeSettings(), makeProbe('available'), registry, () => NOW).check();

    expect(registry.updateProviderConfig).not.toHaveBeenCalled();
    expect(registry.config.models.filter((m) => m.id === FABLE_MODEL_ID)).toHaveLength(1);
  });

  it.each(['unavailable', 'error'] as const)('records %s and leaves the model list alone', async (status) => {
    const settings = makeSettings();
    const registry = makeRegistry([OPUS, FABLE_MODEL_INFO]);
    const result = await new FableAccessService(settings, makeProbe(status, 'why'), registry, () => NOW).check();

    expect(result.status).toBe(status);
    expect(settings.current.lastFableProbe?.status).toBe(status);
    expect(registry.updateProviderConfig).not.toHaveBeenCalled();
    expect(registry.config.models).toContain(FABLE_MODEL_INFO);
  });
});
