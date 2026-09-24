import type { AiProviderKind } from '@lazyit/shared';
import type { LanguageModel } from 'ai';

import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';

/**
 * The provider extension point (provider-and-runtime.md §6.3; ADR-0097 decision 5). Adding a provider is
 * its kind and descriptor in `@lazyit/shared` (`ai-provider.ts`), one `<kind>/<kind>.provider.ts`
 * implementing {@link LlmProviderDefinition}, and one line in `provider.registry.ts`. Nothing outside this
 * folder imports the AI SDK.
 */

/** The `fetch` every provider call uses — always the egress-guarded one from `provider-fetch.ts`. */
export type FetchLike = typeof globalThis.fetch;

/** The connection a definition works from: the resolved settings (key decrypted, in memory only). */
export type ProviderConfig = ResolvedAiProviderConfig;

/** The two tool-choice modes the loop uses; forced `any` / `tool` is never used (§6.1). */
export type ToolChoiceMode = 'auto' | 'none';

/** A model the provider offers, for the wizard's combobox. */
export interface ModelInfo {
  id: string;
  label: string | null;
}

/**
 * Provider wording matched against the message of a 400-class error (read only to classify, never
 * echoed): `contextLimit` → `CONTEXT_LIMIT`; `auth` → `PROVIDER_AUTH` for a provider that answers a bad
 * key with a 400.
 */
export interface ProviderErrorPatterns {
  contextLimit: RegExp;
  auth?: RegExp;
}

/** Per-call settings a definition contributes to one model step. */
export interface ProviderCallSettings {
  /** The `providerOptions` of the call (effort, `store: false`, cache hints…). */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Provider options attached to the system prompt (Anthropic's cache breakpoint). */
  systemProviderOptions?: Record<string, Record<string, unknown>>;
  /** A sampling temperature — only the OpenAI-compatible provider honours one. */
  temperature?: number;
}

export interface LlmProviderDefinition {
  kind: AiProviderKind;
  /**
   * Whether the key is mandatory. When it is and none is configured, the call fails `PROVIDER_AUTH`
   * before any I/O — so the SDK's environment-variable fallback (`ANTHROPIC_API_KEY`, …) never applies.
   */
  requiresApiKey: boolean;
  /** The base URL used when the settings carry none (model listing needs it). */
  defaultBaseUrl: string | null;
  /** Build the SDK model instance. Never a string id: that would route through the Vercel gateway. */
  createModel(
    config: ProviderConfig,
    modelId: string,
    fetch: FetchLike,
  ): LanguageModel;
  /** The provider's knobs for one call, derived from the settings. */
  callSettings(config: ProviderConfig, modelId: string): ProviderCallSettings;
  /** List the models, through the same guarded fetch. Throws {@link AiProviderError} classified. */
  listModels(config: ProviderConfig, fetch: FetchLike): Promise<ModelInfo[]>;
  /**
   * Optional per-call adaptation of the transport, for a behaviour the SDK does not express. Returns the
   * `fetch` the model is built with and the `toolChoice` handed to the SDK.
   */
  adaptCall?(
    fetch: FetchLike,
    toolChoice: ToolChoiceMode,
  ): { fetch: FetchLike; toolChoice: ToolChoiceMode };
  /** How this provider words the failures a status code alone does not tell apart. */
  errorPatterns: ProviderErrorPatterns;
}
