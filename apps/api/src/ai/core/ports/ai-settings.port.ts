import type {
  AiEffort,
  AiProviderKind,
  AiProviderOptions,
  AiSettings,
} from '@lazyit/shared';

/**
 * THE SETTINGS READER PORT (synthesis §5, "ports first"). The settings unit implements it over the
 * `ai_settings` singleton; the runtime, the provider layer, the status endpoint and `/mcp` read through
 * it, so none of them touches the table or the key envelope.
 */

/**
 * The connection the provider layer needs to call the model, with the key DECRYPTED. It exists only in
 * memory, only on the provider path (INV-AI-5, INV-AI-6): never logged, persisted or sent to a client.
 */
export interface ResolvedAiProviderConfig {
  provider: AiProviderKind;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  allowPrivateNetwork: boolean;
  effort: AiEffort | null;
  providerOptions: AiProviderOptions | null;
}

export interface AiSettingsReader {
  /** The redacted settings; the disabled defaults when no row exists. Never carries key material. */
  getSettings(): Promise<AiSettings>;
  /**
   * The provider connection for a model call, or `null` when the assistant is disabled, no provider is
   * configured, or the stored key cannot be decrypted.
   */
  resolveProviderConfig(): Promise<ResolvedAiProviderConfig | null>;
}

/** DI token for the {@link AiSettingsReader} implementation. */
export const AI_SETTINGS_READER = Symbol('AI_SETTINGS_READER');
