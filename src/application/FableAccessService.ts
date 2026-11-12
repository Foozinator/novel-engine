import type { IFableAccessService, IFableProbe, IProviderRegistry, ISettingsService } from '@domain/interfaces';
import type { FableProbeResult } from '@domain/types';
import { CLAUDE_CLI_PROVIDER_ID, FABLE_MODEL_ID, FABLE_MODEL_INFO } from '@domain/constants';

/**
 * On-demand Fable access check (fork issue #16).
 *
 * The probe is a billed Fable request, so it runs only when the user asks
 * from Settings — never at launch. A positive result adds Fable to the Claude
 * CLI model list (persisted with the provider config). A negative result
 * never removes it: access may be lost only for now, and chat errors show it.
 */
export class FableAccessService implements IFableAccessService {
  constructor(
    private settings: ISettingsService,
    private probe: IFableProbe,
    private providers: IProviderRegistry,
    private now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<FableProbeResult> {
    const outcome = await this.probe.probe();
    const result: FableProbeResult = { ...outcome, checkedAt: this.now().toISOString() };
    await this.settings.update({ lastFableProbe: result });

    if (result.status === 'available') {
      const config = this.providers.getProviderConfig(CLAUDE_CLI_PROVIDER_ID);
      if (config && !config.models.some((m) => m.id === FABLE_MODEL_ID)) {
        this.providers.updateProviderConfig(CLAUDE_CLI_PROVIDER_ID, {
          models: [...config.models, FABLE_MODEL_INFO],
        });
      }
    }
    return result;
  }
}
