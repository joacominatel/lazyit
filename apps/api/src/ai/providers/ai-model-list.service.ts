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
import type { FetchLike, ModelInfo } from './provider.types';

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
/** Total budget of one model listing (headers and body). */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

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

  /**
   * The provider's models (ids sorted, capped); free-text entry stays the fallback. Bounded by its own
   * {@link MODEL_LIST_TIMEOUT_MS} (headers and body), not the 600 s model-step deadline; `signal` lets the
   * caller give up earlier.
   */
  async listModels(
    config: ResolvedAiProviderConfig,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    const definition = getProviderDefinition(config.provider);
    if (definition.requiresApiKey && !config.apiKey) {
      throw new AiProviderError('PROVIDER_AUTH');
    }
    const guarded = (this.options.fetchFactory ?? createProviderFetch)({
      kind: definition.kind,
      baseUrl: config.baseUrl,
      allowPrivateNetwork: config.allowPrivateNetwork,
    });

    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS);
    const onCallerAbort = (): void => deadline.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) {
      deadline.abort();
    }
    // Every request of the listing carries the deadline's signal; the transport destroys the socket on
    // abort, which also ends a body still being read.
    const fetch: FetchLike = (input, init) =>
      guarded(input, { ...init, signal: deadline.signal });

    try {
      const models = await definition.listModels(config, fetch);
      if (deadline.signal.aborted) {
        throw new Error('aborted');
      }
      return models;
    } catch (err) {
      if (timedOut) {
        throw new AiProviderError('PROVIDER_UNAVAILABLE');
      }
      if (signal?.aborted) {
        throw new AiProviderError('CANCELLED');
      }
      throw classifyProviderError(err, definition.errorPatterns);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
