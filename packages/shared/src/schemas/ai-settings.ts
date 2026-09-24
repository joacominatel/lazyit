import { z } from "zod";
import {
  AI_PROVIDER_OPTIONS_SCHEMAS,
  AiEffortSchema,
  AiProviderKindSchema,
  AiProviderOptionsSchema,
} from "./ai-provider";
import { BROWSER_INTERPRETED_SCHEMES } from "./application";
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

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * MCP client allowlist (ADR-0097 decision 13)
 *
 * Which OAuth clients may connect over MCP. The curated defaults (Claude Code, Codex, Cursor, …) live in
 * code and ship with the authorization server; `ai_settings` stores only an OVERLAY on them — the
 * admin's own entries and the ids of the defaults the admin removed — so a later release can correct a
 * default's identifier without overwriting what the admin chose. A client is matched on its CIMD
 * `client_id` URL or a redirect-URI pattern, NEVER on its self-declared `client_name`.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Upper bound on the admin's own entries and on the removed-default ids. */
export const MCP_CLIENT_ALLOWLIST_MAX_ENTRIES = 100;

/** A stable entry id: a curated default's key, or the id the API assigns to an admin entry. */
export const McpClientAllowlistEntryIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "Allowlist ids are lower-case letters, digits, '.', '_' or '-'");

const HTTPS_URL = /^https:\/\/\S+$/i;
/** `scheme://authority[/path?query#fragment]` for http(s); the authority is everything up to `/ ? #`. */
const HTTP_URI = /^(https?):\/\/([^/?#]*)([/?#]\S*)?$/i;
/** An authority without userinfo: a bracketed IPv6 literal or a name/IPv4, and an optional port. */
const HOST_PORT = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The HOST of an http(s) URI, parsed from its authority — never pattern-matched on the whole string, so
 * `http://localhost:80@evil.com/` is not mistaken for loopback. Userinfo (`@`), whitespace and
 * backslashes (which WHATWG parsers treat as a path separator) make the URI unusable: `null`. The shared
 * lib has no `URL` (ES2023 lib only), hence the explicit parse.
 */
function httpUriHost(value: string): { scheme: "http" | "https"; host: string } | null {
  if (/[\s\\]/.test(value)) return null;
  const match = HTTP_URI.exec(value);
  if (!match) return null;
  const authority = match[2] ?? "";
  if (authority.includes("@")) return null;
  const hostPort = HOST_PORT.exec(authority);
  if (!hostPort) return null;
  const port = hostPort[2];
  if (port !== undefined && Number(port) > 65535) return null;
  return {
    scheme: match[1]!.toLowerCase() as "http" | "https",
    host: hostPort[1]!.toLowerCase(),
  };
}
const URI_WITH_SCHEME = /^([a-z][a-z0-9+.-]*):\S+$/i;
/** RFC 8252 §7.1 style: a reverse domain name, so at least one `.` (`com.example.app`). */
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Single-label private-use schemes of vetted MCP clients. RFC 8252 §7.1 asks native apps for a
 * reverse-domain scheme, but the editors operators actually run register short vendor schemes; only
 * these are accepted without a `.`. Anything else single-label (`mailto`, `ms-settings`, …) is refused.
 */
export const MCP_VENDOR_REDIRECT_SCHEMES: readonly string[] = [
  "cursor",
  "vscode",
  "vscode-insiders",
  "windsurf",
];

/** What kind of redirect URI a value is, for the allowlist policy (ADR-0097 decision 13). */
export type McpRedirectUriKind = "https" | "loopback" | "private-use";

/**
 * Classifies a redirect URI, or returns `null` when it may never be one:
 *   - `https`       — https on a non-loopback host;
 *   - `loopback`    — http(s) on 127.0.0.1, localhost or [::1] (OAuth's only plain-http redirects);
 *   - `private-use` — a native-app scheme (RFC 8252 §7.1): reverse-domain, or a vetted vendor scheme.
 * Plain http on any other host and every browser-interpreted scheme (SEC-051: `javascript`, `data`,
 * `file`, …) are refused, and so is any URI with userinfo (`user@host`): the host is read from the parsed
 * authority, so `http://localhost:80@evil.com/` is an `evil.com` URI with userinfo, not loopback.
 */
export function classifyMcpRedirectUri(value: string): McpRedirectUriKind | null {
  const scheme = URI_WITH_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) return null;
  if (scheme === "http" || scheme === "https") {
    const parsed = httpUriHost(value);
    if (!parsed) return null;
    if (LOOPBACK_HOSTS.has(parsed.host)) return "loopback";
    return parsed.scheme === "https" ? "https" : null;
  }
  if (BROWSER_INTERPRETED_SCHEMES.has(scheme)) return null;
  // A private-use URI with an authority (`com.example.app://host/cb`) may not carry userinfo either.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority?.includes("@")) return null;
  if (MCP_VENDOR_REDIRECT_SCHEMES.includes(scheme) || REVERSE_DOMAIN_SCHEME.test(scheme)) {
    return "private-use";
  }
  return null;
}

/**
 * How an entry recognizes a client, discriminated on `kind`:
 *   - `cimd_url`     — the client's https Client ID Metadata Document URL (its `client_id`).
 *   - `redirect_uri` — an exact redirect URI: https, loopback http, or a private-use scheme
 *     (`classifyMcpRedirectUri`). A private-use redirect is admitted ONLY through an explicit entry,
 *     never by `mcpAllowAnyHttpsClient` (CEO, 2026-09-23).
 */
export const McpClientAllowlistMatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cimd_url"),
    url: z.string().trim().max(2048).regex(HTTPS_URL, "A CIMD client id must be an https:// URL"),
  }),
  z.object({
    kind: z.literal("redirect_uri"),
    pattern: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) => classifyMcpRedirectUri(value) !== null,
        "A redirect URI must be https://, http:// on a loopback address, or a private-use scheme (reverse-domain such as com.example.app:, or a vetted editor scheme such as cursor:)",
      ),
  }),
]);
export type McpClientAllowlistMatch = z.infer<typeof McpClientAllowlistMatchSchema>;

/** One allowlist entry. `label` is the operator's name for it; it never takes part in matching. */
export const McpClientAllowlistEntrySchema = z.object({
  id: McpClientAllowlistEntryIdSchema,
  label: z.string().trim().min(1).max(120),
  match: McpClientAllowlistMatchSchema,
});
export type McpClientAllowlistEntry = z.infer<typeof McpClientAllowlistEntrySchema>;

const hasUniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

/** The admin's own entries, as written (`ai_settings.mcpClientAllowlistAdded`). Ids are unique. */
export const McpClientAllowlistAddedSchema = z
  .array(McpClientAllowlistEntrySchema)
  .max(MCP_CLIENT_ALLOWLIST_MAX_ENTRIES)
  .refine((entries) => hasUniqueIds(entries.map((entry) => entry.id)), "Allowlist ids must be unique");

/** The ids of the curated defaults the admin removed (`ai_settings.mcpClientAllowlistRemovedDefaults`). */
export const McpClientAllowlistRemovedDefaultsSchema = z
  .array(McpClientAllowlistEntryIdSchema)
  .max(MCP_CLIENT_ALLOWLIST_MAX_ENTRIES)
  .transform((ids) => [...new Set(ids)]);

/**
 * The READ-TOLERANT form of the admin's entries: an entry this build cannot parse (a newer match kind)
 * is dropped instead of failing the whole settings read.
 */
export const McpClientAllowlistAddedReadSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = McpClientAllowlistEntrySchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/**
 * The EFFECTIVE allowlist: the curated defaults minus the removed ids, then the admin's entries. An
 * admin entry whose id collides with a default already in the list is ignored, so the overlay can never
 * silently rewrite a default — the admin removes it and adds their own instead.
 */
export function resolveMcpClientAllowlist(
  defaults: readonly McpClientAllowlistEntry[],
  added: readonly McpClientAllowlistEntry[],
  removedDefaults: readonly string[],
): McpClientAllowlistEntry[] {
  const removed = new Set(removedDefaults);
  const effective = defaults.filter((entry) => !removed.has(entry.id));
  const ids = new Set(effective.map((entry) => entry.id));
  for (const entry of added) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    effective.push(entry);
  }
  return effective;
}

/**
 * How far a curated default's identifier has been checked:
 *   - `verified`    — taken from the client's own source code or its vendor's authoritative
 *                     documentation, and not flagged for re-verification;
 *   - `vendor-docs` — taken from vendor documentation only; it is re-verified before general
 *                     availability (docs/ai-assistant/mcp-and-oauth.md §12).
 */
export const MCP_CLIENT_ALLOWLIST_VERIFICATIONS = ["verified", "vendor-docs"] as const;
export const McpClientAllowlistVerificationSchema = z.enum(MCP_CLIENT_ALLOWLIST_VERIFICATIONS);
export type McpClientAllowlistVerification = z.infer<typeof McpClientAllowlistVerificationSchema>;

/**
 * A CURATED DEFAULT: an allowlist entry plus where its identifier comes from. `verification` and
 * `source` are display metadata for Settings → AI; they never take part in matching.
 */
export const McpClientAllowlistDefaultSchema = McpClientAllowlistEntrySchema.extend({
  verification: McpClientAllowlistVerificationSchema,
  source: z.string().min(1).max(200),
});
export type McpClientAllowlistDefault = z.infer<typeof McpClientAllowlistDefaultSchema>;

/**
 * The CURATED DEFAULT MCP client allowlist (ADR-0097 decision 13) — data only, shared so the
 * authorization server enforces it and Settings → AI lists it (and offers "remove this built-in
 * client", which writes its id to `mcpClientAllowlistRemovedDefaults`). `ai_settings` stores only the
 * overlay, so a later release can correct an identifier here without undoing the admin's choices. Ids
 * are STABLE: renaming one would resurrect a default an admin removed.
 *
 * Matching is on the CIMD `client_id` URL or an exact redirect URI (loopback `http` port-agnostic),
 * NEVER on `client_name`. Where several clients share a loopback callback the label names them all.
 * Where a client's identifier could not be verified (Windsurf, Zed, Pi) it is deliberately NOT seeded —
 * an admin adds it, and docs/ai-assistant/mcp-and-oauth.md §12 tracks the verification.
 *
 * A loopback entry admits any local program that uses that callback path. That is inherent to native
 * OAuth clients (RFC 8252 §8.3) and why the consent screen always shows the redirect host with a
 * loopback warning.
 */
const CURATED_DEFAULTS: McpClientAllowlistDefault[] = [
  {
    id: "claude-code-cimd",
    label: "Claude Code (client metadata document)",
    match: { kind: "cimd_url", url: "https://claude.ai/oauth/claude-code-client-metadata" },
    verification: "verified",
    source: "Claude connector documentation",
  },
  {
    id: "loopback-localhost-callback",
    label: "Claude Code, OpenAI Codex (http://localhost/callback)",
    match: { kind: "redirect_uri", pattern: "http://localhost/callback" },
    verification: "verified",
    source: "Claude Code; OpenAI Codex rmcp-client source",
  },
  {
    id: "loopback-127-callback",
    label: "Claude Code, OpenAI Codex (http://127.0.0.1/callback)",
    match: { kind: "redirect_uri", pattern: "http://127.0.0.1/callback" },
    verification: "verified",
    source: "Claude Code; OpenAI Codex rmcp-client source",
  },
  {
    id: "claude-ai",
    label: "Claude (claude.ai, Claude Desktop, Cowork)",
    match: { kind: "redirect_uri", pattern: "https://claude.ai/api/mcp/auth_callback" },
    verification: "verified",
    source: "Claude connector documentation",
  },
  {
    id: "claude-com",
    label: "Claude (claude.com callback)",
    match: { kind: "redirect_uri", pattern: "https://claude.com/api/mcp/auth_callback" },
    verification: "verified",
    source: "Claude connector documentation",
  },
  {
    id: "chatgpt",
    label: "ChatGPT (developer mode connectors)",
    match: { kind: "redirect_uri", pattern: "https://chatgpt.com/connector_platform_oauth_redirect" },
    verification: "vendor-docs",
    source: "OpenAI developer-mode documentation",
  },
  {
    id: "opencode",
    label: "OpenCode",
    match: { kind: "redirect_uri", pattern: "http://127.0.0.1/mcp/oauth/callback" },
    verification: "verified",
    source: "sst/opencode source (mcp/oauth-provider.ts)",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    match: { kind: "redirect_uri", pattern: "http://localhost/oauth/callback" },
    verification: "verified",
    source: "google-gemini/gemini-cli source (utils/oauth-flow.ts)",
  },
  {
    id: "cursor",
    label: "Cursor",
    match: { kind: "redirect_uri", pattern: "cursor://anysphere.cursor-mcp/oauth/callback" },
    verification: "vendor-docs",
    source: "Cursor documentation",
  },
  {
    id: "vscode-web",
    label: "VS Code / GitHub Copilot (vscode.dev)",
    match: { kind: "redirect_uri", pattern: "https://vscode.dev/redirect" },
    verification: "vendor-docs",
    source: "VS Code dynamic client registration",
  },
  {
    id: "vscode-insiders-web",
    label: "VS Code Insiders (insiders.vscode.dev)",
    match: { kind: "redirect_uri", pattern: "https://insiders.vscode.dev/redirect" },
    verification: "vendor-docs",
    source: "VS Code dynamic client registration",
  },
  {
    id: "vscode-loopback-127",
    label: "VS Code / GitHub Copilot (http://127.0.0.1/)",
    match: { kind: "redirect_uri", pattern: "http://127.0.0.1/" },
    verification: "vendor-docs",
    source: "VS Code dynamic client registration",
  },
  {
    id: "vscode-loopback-localhost",
    label: "VS Code / GitHub Copilot (http://localhost/)",
    match: { kind: "redirect_uri", pattern: "http://localhost/" },
    verification: "vendor-docs",
    source: "VS Code dynamic client registration",
  },
];

/** Parsed through the schema at load, so a malformed default fails the first test run; deep-frozen. */
export const MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS: readonly McpClientAllowlistDefault[] =
  Object.freeze(
    CURATED_DEFAULTS.map((entry) => {
      const parsed = McpClientAllowlistDefaultSchema.parse(entry);
      Object.freeze(parsed.match);
      return Object.freeze(parsed);
    }),
  );

/** Loopback http redirects match on any port (RFC 8252 §7.3); every other part matches exactly. */
const LOOPBACK_HTTP_PORT = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(?=\/|$)/i;
const withoutLoopbackPort = (uri: string) => uri.replace(LOOPBACK_HTTP_PORT, "$1");

/**
 * The redirect-URI half of the client trust policy: whether `redirectUri` may be used, given the
 * EFFECTIVE allowlist (`resolveMcpClientAllowlist`) and the `mcpAllowAnyHttpsClient` toggle.
 *   - An explicit `redirect_uri` entry admits its exact URI (loopback http on any port).
 *   - The toggle admits only https on a non-loopback host; it never admits a loopback or private-use
 *     redirect, which need an explicit entry.
 * `cimd_url` entries identify a client by its `client_id`, which the authorization server checks.
 */
export function isMcpRedirectUriAllowed(
  redirectUri: string,
  allowlist: readonly McpClientAllowlistEntry[],
  allowAnyHttpsClient: boolean,
): boolean {
  const kind = classifyMcpRedirectUri(redirectUri);
  if (kind === null) return false;
  if (allowAnyHttpsClient && kind === "https") return true;
  const candidate = withoutLoopbackPort(redirectUri);
  return allowlist.some(
    (entry) =>
      entry.match.kind === "redirect_uri" && withoutLoopbackPort(entry.match.pattern) === candidate,
  );
}

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
  mcpClientAllowlistAdded: [],
  mcpClientAllowlistRemovedDefaults: [],
  mcpAllowAnyHttpsClient: false,
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
  /** The admin's own MCP allowlist entries (the overlay on the curated defaults). */
  mcpClientAllowlistAdded: McpClientAllowlistAddedReadSchema,
  /** The ids of the curated defaults the admin removed. */
  mcpClientAllowlistRemovedDefaults: z.array(z.string()),
  /** Accept any client with https (non-loopback) redirect URIs, never private-use ones; consent warns. */
  mcpAllowAnyHttpsClient: z.boolean(),
  /** When an admin acknowledged the egress disclosure; required before the first enable. */
  disclosureAcknowledgedAt: z.iso.datetime().nullable(),
  /** When the current connection fields last passed a connection test. */
  verifiedAt: z.iso.datetime().nullable(),
  /** null while no settings row exists (the disabled default). */
  updatedAt: z.iso.datetime().nullable(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/**
 * The stable machine codes of every `/config/ai` refusal (provider-and-runtime.md §9.1). Each refusal
 * body carries `code` next to its human `message`, so the web matches the code, never the sentence.
 *   409 — `AI_SETTINGS_CONCURRENT_SAVE` (reload and save again), `AI_SECRET_KEY_MISSING` (a key write,
 *         or enabling a key-bearing provider, without a usable `AI_SECRET_KEY`), `AI_SHIM_MODE` (test or
 *         enable while `AUTH_MODE=shim`);
 *   400 — the base-URL rules (`BASE_URL_*`), `PRIVATE_NETWORK_PROVIDER_MISMATCH`,
 *         `PROVIDER_OPTIONS_UNSUPPORTED`, and `PROVIDER_NOT_CONFIGURED` for a test without a provider or
 *         model;
 *   422 — the enable gate: `DISCLOSURE_REQUIRED`, `PROVIDER_NOT_CONFIGURED`, `API_KEY_REQUIRED` (with
 *         `reason: "DESTINATION_CHANGED"` when the stored key was just cleared because the provider or
 *         base URL changed), `CONNECTION_TEST_FAILED` (with `test`).
 * The list only grows; a web treats an unknown code as a generic refusal and shows `message`.
 */
export const AI_SETTINGS_ERROR_CODES = [
  "AI_SETTINGS_CONCURRENT_SAVE",
  "AI_SECRET_KEY_MISSING",
  "AI_SHIM_MODE",
  "BASE_URL_INVALID",
  "BASE_URL_CREDENTIALS",
  "BASE_URL_QUERY_OR_FRAGMENT",
  "BASE_URL_SCHEME",
  "BASE_URL_HTTP_NOT_ALLOWED",
  "BASE_URL_LOOPBACK",
  "BASE_URL_HTTP_PUBLIC",
  "BASE_URL_UNREACHABLE_RANGE",
  "BASE_URL_PRIVATE_NOT_ALLOWED",
  "PRIVATE_NETWORK_PROVIDER_MISMATCH",
  "PROVIDER_OPTIONS_UNSUPPORTED",
  "DISCLOSURE_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "API_KEY_REQUIRED",
  "CONNECTION_TEST_FAILED",
] as const;
export type AiSettingsErrorCode = (typeof AI_SETTINGS_ERROR_CODES)[number];

/** Why `API_KEY_REQUIRED` fired, when there is more to say than "no key". */
export const AI_API_KEY_REQUIRED_REASONS = ["DESTINATION_CHANGED"] as const;
export type AiApiKeyRequiredReason = (typeof AI_API_KEY_REQUIRED_REASONS)[number];

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
    mcpClientAllowlistAdded: McpClientAllowlistAddedSchema,
    mcpClientAllowlistRemovedDefaults: McpClientAllowlistRemovedDefaultsSchema,
    mcpAllowAnyHttpsClient: z.boolean(),
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
 * The body of a `/config/ai` refusal. `code` is kept an open string on read so an older web renders a
 * newer code generically; the 400/409 bodies also carry Nest's `statusCode` and `error`.
 */
export const AiSettingsErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  reason: z.string().optional(),
  test: AiConnectionTestResultSchema.optional(),
});
export type AiSettingsError = z.infer<typeof AiSettingsErrorSchema>;

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
 * optional cap on executed writes per headless run; null = no cap beyond the global step limit. Over MCP,
 * which has no runs, the same value caps the writes the Service Account attempts through `/mcp` in any
 * rolling hour (CTO decision, #1315; mcp-and-oauth.md §14) — setting help text should say both.
 */
export const AiServiceAccountSettingsSchema = z.strictObject({
  access: AiServiceAccountAccessSchema,
  maxMutationsPerRun: int4({ min: 1 }).nullable(),
});
export type AiServiceAccountSettings = z.infer<typeof AiServiceAccountSettingsSchema>;
