import { Inject, Injectable, Optional } from '@nestjs/common';

import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';
import { AiProviderError } from './ai-provider.error';
import {
  AI_PROVIDER_LAYER_OPTIONS,
  type AiProviderLayerOptions,
} from './model-step';
import { classifyProviderError } from './provider-errors';
import { createProviderFetch } from './provider-fetch';
import { getProviderDefinition } from './provider.registry';
import type { ModelInfo } from './provider.types';

/**
 * Model suggestions for the wizard's combobox (`POST /config/ai/models`; provider-and-runtime.md §6.3,
 * §10). Not part of `ChatModelPort`: it takes an EXPLICIT connection (the wizard lists models for a draft
 * before saving it). It goes through the same definition and egress-guarded fetch as a model step and
 * throws only {@link AiProviderError} — a run error code and a fixed message, never the upstream body
 * (security.md §6.4).
 *
 * The connection TEST is not here: the settings unit runs one `ChatModelPort.step` under a scoped
 * settings override (provider-and-runtime.md §6.3, as built).
 */
@Injectable()
export class AiModelListService {
  private readonly options: AiProviderLayerOptions;

  constructor(
    @Optional()
    @Inject(AI_PROVIDER_LAYER_OPTIONS)
    options?: AiProviderLayerOptions,
  ) {
    this.options = options ?? {};
  }

  /** The provider's models (ids sorted, capped); free-text entry stays the fallback. */
  async listModels(config: ResolvedAiProviderConfig): Promise<ModelInfo[]> {
    const definition = getProviderDefinition(config.provider);
    if (definition.requiresApiKey && !config.apiKey) {
      throw new AiProviderError('PROVIDER_AUTH');
    }
    const fetch = (this.options.fetchFactory ?? createProviderFetch)({
      kind: definition.kind,
      baseUrl: config.baseUrl,
      allowPrivateNetwork: config.allowPrivateNetwork,
    });
    try {
      return await definition.listModels(config, fetch);
    } catch (err) {
      throw classifyProviderError(err, definition.errorPatterns);
    }
  }
}
