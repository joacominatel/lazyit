import { z } from "zod";
import {
  AI_PROVIDER_OPTIONS_SCHEMAS,
  AiEffortSchema,
  AiProviderKindSchema,
  AiProviderOptionsSchema,
} from "./ai-provider";
import { int4 } from "./primitives";

/**
 * AI configuration, status and per-service-account AI access (ADR-0097 decisions 1, 4 and 7;
 * docs/ai-assistant/_synthesis.md §4.5, §4.7; provider-and-runtime.md §9.1).
 *
 * `AiSettings` is a singleton instance-config row that mirrors the SMTP precedent (ADR-0079):
 * `settings:manage` only, OFF by default, and an absent row reads as the disabled default. The provider
 * API key is encrypted at rest under its own key axis (`AI_SECRET_KEY`) and is WRITE-ONLY on the wire:
 * the read shape carries `apiKeySet`, never the key or its ciphertext (INV-AI-6).
 */

/** Retention bounds for conversation transcripts, in days (synthesis §8.1 item 4: 7–3650, no "forever"). */
export const AI_RETENTION_DAYS_MIN = 7;
export const AI_RETENTION_DAYS_MAX = 3650;

/** The admin addendum to the frozen system prompt is capped (provider-and-runtime.md §7). */
export const AI_INSTRUCTIONS_MAX_LENGTH = 4000;

/**
 * The defaults an absent settings row reads as. They mirror the column defaults of the `ai_settings`
 * table, so "no row" and "a row nobody edited" behave the same.
 */
export const AI_SETTINGS_DEFAULTS = {
  enabled: false,
  maxStepsPerRun: 20,
  maxOutputTokens: 16_000,
  contextTokenLimit: 150_000,
  dailyTokenLimitPerPrincipal: 2_000_000,
  retentionDays: 90,
  approvalTtlMinutes: 30,
  mcpEnabled: false,
  allowPrivateNetwork: false,
} as const;

/**
 * The REDACTED read shape of `GET /config/ai`. Never carries the key: `apiKeySet` says whether an
 * encrypted key is stored, and `keyConfigured` whether `AI_SECRET_KEY` is present and usable, so the
 * form can explain why a key cannot be saved.
 *
 * Read tolerance: the API maps a provider or effort value it does not know (written by a newer build)
 * to `null` before answering, so this shape stays strict.
 */
export const AiSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: AiProviderKindSchema.nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  /** Whether an encrypted provider key is stored. The key itself is never returned. */
  apiKeySet: z.boolean(),
  /** Whether the server's `AI_SECRET_KEY` is present, so a key can be stored at all. */
  keyConfigured: z.boolean(),
  /** OpenAI-compatible only: allow a private-network host (scoped to the base URL's host, INV-AI-7). */
  allowPrivateNetwork: z.boolean(),
  effort: AiEffortSchema.nullable(),
  providerOptions: AiProviderOptionsSchema.nullable(),
  /** The admin addendum to the frozen system prompt. */
  instructions: z.string().nullable(),
  maxStepsPerRun: int4({ min: 1 }),
  maxOutputTokens: int4({ min: 1 }),
  contextTokenLimit: int4({ min: 1 }),
  /** Rolling 24 h token budget per principal; null = no budget. */
  dailyTokenLimitPerPrincipal: int4({ min: 1 }).nullable(),
  retentionDays: int4({ min: AI_RETENTION_DAYS_MIN, max: AI_RETENTION_DAYS_MAX }),
  approvalTtlMinutes: int4({ min: 1 }),
  /** The independent MCP switch — usable without an LLM provider (CEO, round 2). */
  mcpEnabled: z.boolean(),
  /** When an admin acknowledged the egress disclosure; required before the first enable. */
  disclosureAcknowledgedAt: z.iso.datetime().nullable(),
  /** When the current connection fields last passed a connection test. */
  verifiedAt: z.iso.datetime().nullable(),
  /** null while no settings row exists (the disabled default). */
  updatedAt: z.iso.datetime().nullable(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

const aiModelId = z.string().trim().min(1).max(200);
const aiBaseUrl = z
  .url()
  .max(2048)
  // http is accepted here and narrowed by the API: only an OpenAI-compatible target that resolves to an
  // allowlisted private host may use it (INV-AI-7). A regex, not `new URL()`: the shared lib has no URL.
  .refine((value) => /^https?:\/\//i.test(value.trim()), "Must be an http(s):// URL");

/**
 * `PUT /config/ai` — a wholesale write of the configuration (the SMTP pattern), so a half-filled draft
 * can be saved with `enabled: false` and the enable gate runs server-side.
 *
 * The KEY is write-only (INV-AI-6):
 *   - omitted → the stored key is kept;
 *   - a string → it is encrypted and stored (set or rotate);
 *   - `null` → the stored key is cleared.
 * Changing `provider` or `baseUrl` clears the stored key on the server, so a new key must accompany the
 * change (destination binding).
 *
 * `acknowledgeDisclosure: true` records the egress disclosure with its author; the first
 * `enabled: true` is refused without it.
 */
export const UpdateAiSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    provider: AiProviderKindSchema.nullable(),
    model: aiModelId.nullable(),
    baseUrl: aiBaseUrl.nullable(),
    apiKey: z.string().trim().min(1).max(4096).nullable().optional(),
    allowPrivateNetwork: z.boolean(),
    effort: AiEffortSchema.nullable(),
    providerOptions: AiProviderOptionsSchema.nullable(),
    instructions: z.string().trim().max(AI_INSTRUCTIONS_MAX_LENGTH).nullable(),
    maxStepsPerRun: int4({ min: 1 }),
    maxOutputTokens: int4({ min: 1 }),
    contextTokenLimit: int4({ min: 1 }),
    dailyTokenLimitPerPrincipal: int4({ min: 1 }).nullable(),
    retentionDays: int4({ min: AI_RETENTION_DAYS_MIN, max: AI_RETENTION_DAYS_MAX }),
    approvalTtlMinutes: int4({ min: 1 }),
    mcpEnabled: z.boolean(),
    acknowledgeDisclosure: z.boolean().optional(),
  })
  .refine((value) => !value.allowPrivateNetwork || value.provider === "openai-compatible", {
    path: ["allowPrivateNetwork"],
    message: "A private-network host is allowed only for the OpenAI-compatible provider",
  })
  .refine(
    (value) =>
      value.providerOptions === null ||
      (value.provider !== null &&
        AI_PROVIDER_OPTIONS_SCHEMAS[value.provider].safeParse(value.providerOptions).success),
    {
      path: ["providerOptions"],
      message: "These options are not supported by the selected provider",
    },
  );
export type UpdateAiSettings = z.infer<typeof UpdateAiSettingsSchema>;

/**
 * A DRAFT of the connection fields for `POST /config/ai/test` and `POST /config/ai/models`: each field
 * given here overrides the saved value, and the key may be supplied inline so the wizard can test before
 * saving. An empty body tests the saved configuration.
 */
export const AiConnectionDraftSchema = z.strictObject({
  provider: AiProviderKindSchema.optional(),
  model: aiModelId.optional(),
  baseUrl: aiBaseUrl.nullable().optional(),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  providerOptions: AiProviderOptionsSchema.nullable().optional(),
});
export type AiConnectionDraft = z.infer<typeof AiConnectionDraftSchema>;

/**
 * The outcome of one connection-test check: `null` when it did not run (a failed `auth` check skips
 * `model` and `toolCalling`).
 */
const aiCheckResult = z.boolean().nullable();

/**
 * `POST /config/ai/test` response (HTTP 200 either way). `error` is short and never echoes the upstream
 * body or any credential; `code` is one of the run error codes (`PROVIDER_AUTH`, `EGRESS_DENIED`, …),
 * kept an open string so an older web renders a newer code generically.
 */
export const AiConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checks: z.object({
    auth: aiCheckResult,
    model: aiCheckResult,
    toolCalling: aiCheckResult,
  }),
  latencyMs: int4({ min: 0 }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type AiConnectionTestResult = z.infer<typeof AiConnectionTestResultSchema>;

/** `POST /config/ai/models` response — suggestions for the model combobox (free text stays allowed). */
export const AiModelListSchema = z.object({
  models: z.array(z.object({ id: z.string().min(1), label: z.string().nullable() })),
});
export type AiModelList = z.infer<typeof AiModelListSchema>;

/**
 * How `/mcp` authenticates on this instance: OAuth 2.1 on an HTTPS instance, personal tokens on a
 * plain-HTTP `lan` instance (CEO, round 2).
 */
export const AI_MCP_AUTH_MODES = ["oauth", "personal-token"] as const;
export const AiMcpAuthModeSchema = z.enum(AI_MCP_AUTH_MODES);
export type AiMcpAuthMode = z.infer<typeof AiMcpAuthModeSchema>;

/**
 * `GET /ai/status` — per caller, for any authenticated principal (synthesis §4.5). No secrets and no
 * provider credentials. `chat.available` = enabled ∧ provider configured ∧ `ai:use`;
 * `mcp.available` = MCP switch ∧ `ai:connect`. `configRevision` changes whenever the settings change,
 * so other shells notice an enable or disable. The web treats a 404 or any error as "off".
 */
export const AiStatusSchema = z.object({
  chat: z.object({ available: z.boolean() }),
  mcp: z.object({ available: z.boolean(), auth: AiMcpAuthModeSchema }),
  configRevision: z.string(),
  retentionDays: int4({ min: 0 }).nullable(),
});
export type AiStatus = z.infer<typeof AiStatusSchema>;

/**
 * A Service Account's AI access (CEO round 2, ADR-0097 decision 4 — the per-SA placement is the CTO's
 * interpretation). It narrows the headless channel on top of the SA's grants:
 *   - `off`        — no AI run for this SA;
 *   - `read-only`  — only `read`-class tools;
 *   - `read-write` — every tool the SA's grants allow (the default when no row exists).
 */
export const AI_SERVICE_ACCOUNT_ACCESS_LEVELS = ["off", "read-only", "read-write"] as const;
export const AiServiceAccountAccessSchema = z.enum(AI_SERVICE_ACCOUNT_ACCESS_LEVELS);
export type AiServiceAccountAccess = z.infer<typeof AiServiceAccountAccessSchema>;

/** The value an absent `ai_service_account_settings` row reads as. */
export const AI_SERVICE_ACCOUNT_ACCESS_DEFAULT: AiServiceAccountAccess = "read-write";

/**
 * `GET` / `PUT /config/ai/service-accounts/:id` — the same shape both ways. `maxMutationsPerRun` is an
 * optional cap on executed writes per headless run; null = no cap beyond the global step limit.
 */
export const AiServiceAccountSettingsSchema = z.strictObject({
  access: AiServiceAccountAccessSchema,
  maxMutationsPerRun: int4({ min: 1 }).nullable(),
});
export type AiServiceAccountSettings = z.infer<typeof AiServiceAccountSettingsSchema>;
