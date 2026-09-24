import { z } from "zod";

/**
 * AI provider kinds and their descriptors (ADR-0097 decision 5, docs/ai-assistant/provider-and-runtime.md
 * §6.3). The provider layer is the extension point: adding a provider is one kind here, one descriptor,
 * one definition file in `apps/api/src/ai/providers/<kind>/` and one registry line. The kind is stored in
 * a TEXT column (`AiSettings.provider`), validated on write and tolerated on read, so adding a kind needs
 * no migration and an older build reading a newer kind degrades to "not configured" instead of crashing.
 */

export const AI_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
] as const;
export const AiProviderKindSchema = z.enum(AI_PROVIDER_KINDS);
export type AiProviderKind = z.infer<typeof AiProviderKindSchema>;

/**
 * The reasoning effort an admin may pick. Each provider definition maps it onto its own knob (Anthropic
 * `effort`, OpenAI `reasoningEffort`, Gemini thinking level). `null` on the settings row means "the
 * provider's default".
 */
export const AI_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export const AiEffortSchema = z.enum(AI_EFFORT_LEVELS);
export type AiEffort = z.infer<typeof AiEffortSchema>;

/**
 * The shape that drives the setup wizard generically: the web renders one card per descriptor and
 * shows the key and base-URL fields each one needs. Presentation data only — the API decides.
 */
export const AiProviderDescriptorSchema = z.object({
  kind: AiProviderKindSchema,
  /** Display name (the web localizes the surrounding copy, not the brand). */
  label: z.string().min(1),
  /** Whether the provider needs an API key (a local OpenAI-compatible server may not). */
  requiresApiKey: z.boolean(),
  /** Whether the admin must enter a base URL (only the OpenAI-compatible provider). */
  requiresBaseUrl: z.boolean(),
  /** Pre-filled base URL; null means the provider SDK's own endpoint. */
  defaultBaseUrl: z.string().nullable(),
  /** A starting model id for the model combobox; free text is always allowed. */
  suggestedModel: z.string().nullable(),
  /** Whether `POST /config/ai/models` can list models for this provider. */
  supportsModelListing: z.boolean(),
  /**
   * Whether the provider definition sends a reasoning effort (`AiEffort`). The OpenAI-compatible
   * provider does not (servers differ on `reasoning_effort`), so a per-conversation effort is refused
   * for it on write (#1373).
   */
  supportsEffort: z.boolean(),
});
export type AiProviderDescriptor = z.infer<typeof AiProviderDescriptorSchema>;

/**
 * The descriptors, one per kind. `suggestedModel` is a hint for the wizard as of 2026-09 (the provider
 * note's model survey); it goes stale over time and never constrains what an admin may enter.
 */
export const AI_PROVIDER_DESCRIPTORS: Readonly<
  Record<AiProviderKind, AiProviderDescriptor>
> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic",
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: null,
    suggestedModel: "claude-opus-5",
    supportsModelListing: true,
    supportsEffort: true,
  },
  openai: {
    kind: "openai",
    label: "OpenAI",
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: null,
    suggestedModel: "gpt-6-sol",
    supportsModelListing: true,
    supportsEffort: true,
  },
  google: {
    kind: "google",
    label: "Google Gemini",
    requiresApiKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: null,
    suggestedModel: "gemini-3.8-flash",
    supportsModelListing: true,
    supportsEffort: true,
  },
  "openai-compatible": {
    kind: "openai-compatible",
    label: "OpenAI-compatible",
    requiresApiKey: false,
    requiresBaseUrl: true,
    defaultBaseUrl: null,
    suggestedModel: null,
    supportsModelListing: true,
    supportsEffort: false,
  },
};

/**
 * Per-provider extras stored in `AiSettings.providerOptions` (jsonb). Strict objects, so an extra that a
 * provider does not honour is refused on write instead of being silently ignored. Only the
 * OpenAI-compatible provider accepts a `temperature`: the hosted Anthropic models reject sampling
 * parameters with a 400, and the other hosted providers are driven through `effort`.
 */
export const AI_PROVIDER_OPTIONS_SCHEMAS = {
  anthropic: z.strictObject({}),
  openai: z.strictObject({}),
  google: z.strictObject({}),
  "openai-compatible": z.strictObject({
    temperature: z.number().min(0).max(2).optional(),
  }),
} as const satisfies Record<AiProviderKind, z.ZodType>;

/** The union of every provider's extras — the loose wire shape; the per-provider check runs on write. */
export const AiProviderOptionsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
});
export type AiProviderOptions = z.infer<typeof AiProviderOptionsSchema>;
