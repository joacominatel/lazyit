import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDER_DESCRIPTORS,
  AI_PROVIDER_OPTIONS_SCHEMAS,
  type AiModelCatalog,
} from '@lazyit/shared';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
  type ResolvedAiProviderConfig,
} from '../core/ports/ai-settings.port';
import { AiProviderError } from '../providers/ai-provider.error';
import { AiModelListService } from '../providers/ai-model-list.service';
import type { ModelInfo } from '../providers/provider.types';

/** How long a successful provider listing is served from memory. */
export const AI_MODEL_CATALOG_TTL_MS = 10 * 60_000;
/** How long a failed listing is remembered, so a broken provider is not asked on every picker open. */
export const AI_MODEL_CATALOG_ERROR_TTL_MS = 60_000;

type Listing = { ok: true; models: ModelInfo[] } | { ok: false; code: string };

interface CacheEntry {
  key: string;
  expiresAt: number;
  listing: Promise<Listing>;
}

/**
 * `GET /ai/models` (#1373): the chat's model picker. The configured provider's models, listed through
 * the provider layer's `AiModelListService` (the same egress-guarded fetch as a model step) and CACHED
 * per connection — one listing per 10 minutes per instance however many users open the picker, with
 * concurrent requests sharing one call. A failed listing is not an error for the caller: it answers
 * `listed: false` with the run error code, and the picker still offers the default and free text.
 *
 * Exposes the provider kind and model ids to `ai:use` holders (the CTO's scope for #1373) — never the
 * key, the base URL or anything else of the connection.
 */
@Injectable()
export class AiModelCatalogService {
  private cache: CacheEntry | null = null;
  /** The clock (a spec replaces it). */
  now: () => number = () => Date.now();

  constructor(
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    private readonly lister: AiModelListService,
  ) {}

  async catalog(): Promise<AiModelCatalog> {
    const config = await this.settings.resolveProviderConfig();
    if (!config) {
      throw new ConflictException({
        code: 'AI_DISABLED',
        message: 'The AI assistant is not available',
      });
    }
    const [settings, listing] = await Promise.all([
      this.settings.getSettings(),
      this.listing(config),
    ]);
    const optionKeys = Object.keys(
      AI_PROVIDER_OPTIONS_SCHEMAS[config.provider].shape,
    );
    const models = listing.ok ? [...listing.models] : [];
    if (!models.some((model) => model.id === config.model)) {
      // The admin's default is always offered, listed or not (a custom deployment id).
      models.unshift({ id: config.model, label: null });
    }
    return {
      provider: config.provider,
      defaultModel: config.model,
      defaultEffort: settings.effort,
      supportsEffort: AI_PROVIDER_DESCRIPTORS[config.provider].supportsEffort,
      providerOptionKeys: optionKeys,
      models: models.map((model) => ({ id: model.id, label: model.label })),
      listed: listing.ok,
      listingError: listing.ok ? null : listing.code,
    };
  }

  /** The cached listing for this connection, or a new one. The key never holds the API key itself. */
  private listing(config: ResolvedAiProviderConfig): Promise<Listing> {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          config.provider,
          config.baseUrl,
          config.allowPrivateNetwork,
          config.apiKey,
        ]),
      )
      .digest('hex');
    const now = this.now();
    if (this.cache && this.cache.key === key && this.cache.expiresAt > now) {
      return this.cache.listing;
    }
    const entry: CacheEntry = {
      key,
      expiresAt: now + AI_MODEL_CATALOG_TTL_MS,
      listing: this.lister.listModels(config).then(
        (models): Listing => ({ ok: true, models }),
        (err: unknown): Listing => {
          entry.expiresAt = this.now() + AI_MODEL_CATALOG_ERROR_TTL_MS;
          return {
            ok: false,
            code:
              err instanceof AiProviderError
                ? err.code
                : 'PROVIDER_UNAVAILABLE',
          };
        },
      ),
    };
    this.cache = entry;
    return entry.listing;
  }
}
