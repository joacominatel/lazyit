/**
 * AI configuration constants (ADR-0097 decision 7; provider-and-runtime.md §9.1, §12). API-internal
 * names; the wire vocabulary lives in `@lazyit/shared` (`ai-settings.ts`).
 */

/** The env var holding the AI subsystem's own key axis. Optional: the API boots without it. */
export const AI_SECRET_KEY_ENV = 'AI_SECRET_KEY';

/** GCM additional data for the provider-key envelope — binds a ciphertext to this one column. */
export const AI_PROVIDER_KEY_PURPOSE = 'ai_settings.apiKey';

/** The fixed singleton key (the migration's CHECK pins it). */
export const AI_SETTINGS_SINGLETON_ID = 'singleton';

/**
 * `AiConfigAuditLog.action` vocabulary owned by this module. Append-only rows; `detail` is redacted and
 * never carries a key, a ciphertext or the admin instructions text.
 */
export const AI_CONFIG_AUDIT_ACTIONS = {
  /** A `PUT /config/ai` that changed at least one field; `detail.changes` is the redacted diff. */
  settingsUpdated: 'settings.updated',
  /** The egress disclosure was acknowledged; the row's actor is its author. */
  disclosureAcknowledged: 'disclosure.acknowledged',
} as const;

/** The connection test's model-call bounds: small, and a hard deadline so the admin gets an answer. */
export const AI_CONNECTION_TEST_MAX_OUTPUT_TOKENS = 1024;
export const AI_CONNECTION_TEST_TIMEOUT_MS = 60_000;
