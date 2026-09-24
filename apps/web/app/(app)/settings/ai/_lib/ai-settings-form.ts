import {
  AI_PROVIDER_DESCRIPTORS,
  type AiConnectionDraft,
  AiConnectionTestResultSchema,
  type AiConnectionTestResult,
  type AiEffort,
  type AiMcpAuthMode,
  type AiProviderKind,
  type AiProviderOptions,
  type AiSettings,
  classifyMcpRedirectUri,
  McpClientAllowlistEntryIdSchema,
  McpClientAllowlistEntrySchema,
  type McpClientAllowlistEntry,
  type UpdateAiSettings,
} from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

/**
 * Pure logic behind Settings → AI (ADR-0097; docs/ai-assistant/frontend.md §5.3, §7 K2). Everything
 * here is framework-free so `bun test` covers it; the components only render what it decides. The API
 * stays the real gate — these helpers shape a request and explain an answer, they never authorize.
 */

/* ─────────────────────────────── the wholesale PUT ─────────────────────────────── */

/**
 * The `PUT /config/ai` body that re-saves `settings` exactly as read. `PUT` is a wholesale write (the
 * SMTP pattern), so every save starts here and overrides only what the admin changed. The key is NEVER
 * part of it: omitted means "keep the stored key", and the read shape never carries one anyway.
 * A removed-default id this build cannot represent is dropped rather than failing the save.
 */
export function settingsToUpdate(settings: AiSettings): UpdateAiSettings {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    allowPrivateNetwork: settings.allowPrivateNetwork,
    effort: settings.effort,
    providerOptions: settings.providerOptions,
    instructions: settings.instructions,
    maxStepsPerRun: settings.maxStepsPerRun,
    maxOutputTokens: settings.maxOutputTokens,
    contextTokenLimit: settings.contextTokenLimit,
    dailyTokenLimitPerPrincipal: settings.dailyTokenLimitPerPrincipal,
    retentionDays: settings.retentionDays,
    approvalTtlMinutes: settings.approvalTtlMinutes,
    mcpEnabled: settings.mcpEnabled,
    mcpClientAllowlistAdded: settings.mcpClientAllowlistAdded,
    mcpClientAllowlistRemovedDefaults: settings.mcpClientAllowlistRemovedDefaults.filter(
      (id) => McpClientAllowlistEntryIdSchema.safeParse(id).success,
    ),
    mcpAllowAnyHttpsClient: settings.mcpAllowAnyHttpsClient,
  };
}

/** {@link settingsToUpdate} with `patch` applied on top. */
export function buildUpdate(
  settings: AiSettings,
  patch: Partial<UpdateAiSettings>,
): UpdateAiSettings {
  return { ...settingsToUpdate(settings), ...patch };
}

/** A blank string → null; anything else trimmed. */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/* ─────────────────────────────── the provider key ─────────────────────────────── */

/**
 * Whether saving a connection with `provider` / `baseUrl` moves it to a new destination. The server
 * clears the stored key when it does (destination binding, INV-AI-6), so the form must collect a new
 * one — and must not promise "leave blank to keep".
 */
export function isDestinationChange(
  settings: Pick<AiSettings, "provider" | "baseUrl">,
  provider: AiProviderKind | null,
  baseUrl: string | null,
): boolean {
  return settings.provider !== provider || settings.baseUrl !== baseUrl;
}

/**
 * What the key field must say for a draft connection:
 *   - `keep`     — a key is stored for this very destination: blank keeps it;
 *   - `required` — the provider needs a key and none will be stored after saving;
 *   - `optional` — a keyless provider (OpenAI-compatible) with nothing stored.
 */
export type KeyFieldState = "keep" | "required" | "optional";

export function keyFieldState(
  settings: Pick<AiSettings, "provider" | "baseUrl" | "apiKeySet">,
  provider: AiProviderKind,
  baseUrl: string | null,
): KeyFieldState {
  if (settings.apiKeySet && !isDestinationChange(settings, provider, baseUrl)) {
    return "keep";
  }
  return AI_PROVIDER_DESCRIPTORS[provider].requiresApiKey ? "required" : "optional";
}

/* ─────────────────────────────── the base URL ─────────────────────────────── */

/** Why a base URL cannot be saved, judged from the text alone (the API re-checks, and decides). */
export type BaseUrlProblem =
  | "required"
  | "invalid"
  | "scheme"
  | "credentials"
  | "queryFragment"
  | "httpNeedsPrivate"
  | "loopback";

/**
 * Early feedback on a base URL, mirroring the save-time rules of `PUT /config/ai` that can be judged
 * without DNS: http(s) only, no userinfo, no query or fragment, no loopback name, and plain `http://`
 * only for the OpenAI-compatible provider with the private-network option on. The API's answer is
 * authoritative (it also classifies literal IPs) — this only saves a round trip.
 */
export function baseUrlProblem(
  raw: string,
  provider: AiProviderKind,
  allowPrivateNetwork: boolean,
): BaseUrlProblem | null {
  const value = raw.trim();
  if (value === "") {
    return AI_PROVIDER_DESCRIPTORS[provider].requiresBaseUrl ? "required" : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username || url.password) return "credentials";
  if (url.search || url.hash || /[?#]/.test(value)) return "queryFragment";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (
    url.protocol === "http:" &&
    !(provider === "openai-compatible" && allowPrivateNetwork)
  ) {
    return "httpNeedsPrivate";
  }
  return null;
}

/* ─────────────────────────────── the wizard ─────────────────────────────── */

export const AI_WIZARD_STEPS = [
  "provider",
  "credentials",
  "model",
  "test",
  "enable",
] as const;
export type AiWizardStep = (typeof AI_WIZARD_STEPS)[number];

/**
 * Where the wizard opens for a saved (disabled) configuration: at the first step that still needs the
 * admin. A fresh instance starts at the provider; a draft that already has a connection resumes at the
 * model or the test — the admin never re-types what is saved.
 */
export function initialWizardStep(
  settings: Pick<
    AiSettings,
    "provider" | "model" | "baseUrl" | "apiKeySet"
  >,
): AiWizardStep {
  const provider = settings.provider;
  if (!provider) return "provider";
  const descriptor = AI_PROVIDER_DESCRIPTORS[provider];
  if (descriptor.requiresBaseUrl && !settings.baseUrl) return "credentials";
  if (descriptor.requiresApiKey && !settings.apiKeySet) return "credentials";
  if (!settings.model) return "model";
  return "test";
}

/* ─────────────────────────────── API errors ─────────────────────────────── */

/** An explained API failure: a key under `aiSettings.errors`, plus what the UI shows with it. */
export interface AiSettingsErrorInfo {
  key: string;
  /** The server's own message, for the generic fallbacks (English, from the API). */
  message?: string;
  /** The failed connection test, when the enable gate ran one. */
  test?: AiConnectionTestResult;
  requestId?: string;
}

const ENABLE_GATE_CODES = new Set([
  "DISCLOSURE_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "API_KEY_REQUIRED",
  "CONNECTION_TEST_FAILED",
]);

/**
 * The 409s of `/config/ai` carry no code (plain `ConflictException`s), so they are told apart by their
 * fixed server sentences. An unrecognized 409 still gets a generic "conflict" with the server's text.
 */
const CONFLICT_PATTERNS: readonly [RegExp, string][] = [
  [/AI_SECRET_KEY/, "secretKeyMissing"],
  [/AUTH_MODE=shim/, "shimMode"],
  [/changed by someone else|reload them and save again/i, "concurrentSave"],
];

/** The 400s of `/config/ai` beyond schema validation — the base-URL and shape rules. */
const BAD_REQUEST_PATTERNS: readonly [RegExp, string][] = [
  [/may not carry credentials/i, "baseUrl.credentials"],
  [/query string or a fragment/i, "baseUrl.queryFragment"],
  [/must be http:\/\/ or https:\/\//i, "baseUrl.scheme"],
  [/plain http:\/\/ base URL is allowed only/i, "baseUrl.httpNeedsPrivate"],
  [/must point at a private-network address/i, "baseUrl.httpPublic"],
  [/loopback base URL/i, "baseUrl.loopback"],
  [/never reachable/i, "baseUrl.unreachable"],
  [/private-network base URL needs/i, "baseUrl.privateNeedsOption"],
  [/not a valid URL/i, "baseUrl.invalid"],
  [/private-network host is allowed only/i, "privateNetworkProviderOnly"],
  [/not supported by the selected provider/i, "providerOptions"],
  [/Choose a provider and a model/i, "providerAndModelFirst"],
];

function bodyOf(error: ApiError): Record<string, unknown> {
  return error.body !== null && typeof error.body === "object"
    ? (error.body as Record<string, unknown>)
    : {};
}

/**
 * Explain a failed `/config/ai` call: the enable gate's 422 codes (with the failed test), every 409
 * (missing `AI_SECRET_KEY`, shim mode, a concurrent save), the base-URL and shape 400s, schema 400s, 403
 * and 404. Anything else is a generic failure that keeps the request id.
 */
export function describeAiSettingsError(error: unknown): AiSettingsErrorInfo {
  if (!(error instanceof ApiError)) return { key: "network" };
  const requestId = error.requestId;
  const body = bodyOf(error);
  const serverMessage =
    typeof body.message === "string" ? body.message : error.message;

  if (error.status === 422 && typeof body.code === "string" && ENABLE_GATE_CODES.has(body.code)) {
    const test = AiConnectionTestResultSchema.safeParse(body.test);
    return {
      key: `gate.${body.code}`,
      test: test.success ? test.data : undefined,
      requestId,
    };
  }
  if (error.status === 409) {
    const match = CONFLICT_PATTERNS.find(([pattern]) => pattern.test(serverMessage));
    return match
      ? { key: match[1], requestId }
      : { key: "conflict", message: serverMessage, requestId };
  }
  if (error.status === 400) {
    const match = BAD_REQUEST_PATTERNS.find(([pattern]) => pattern.test(serverMessage));
    if (match) return { key: match[1], requestId };
    if (Array.isArray(body.errors) || Array.isArray(body.issues)) {
      return { key: "validation", requestId };
    }
    return { key: "badRequest", message: serverMessage, requestId };
  }
  if (error.status === 403) return { key: "forbidden", requestId };
  if (error.status === 404) return { key: "notFound", requestId };
  return { key: "generic", message: serverMessage, requestId };
}

/** The connection-test failure codes the web has copy for; any other code shows the server's text. */
export const AI_TEST_ERROR_CODES = [
  "PROVIDER_AUTH",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BAD_REQUEST",
  "PROVIDER_REFUSED",
  "EGRESS_DENIED",
  "TOOL_CALLING_UNSUPPORTED",
  "PROVIDER_LAYER_UNAVAILABLE",
] as const;

/** The `aiSettings.test.codes` key for a test error code, or null when the web has no copy for it. */
export function testErrorKey(code: string | null | undefined): string | null {
  return code && (AI_TEST_ERROR_CODES as readonly string[]).includes(code) ? code : null;
}

/* ─────────────────────────────── MCP ─────────────────────────────── */

/** The MCP endpoint external clients connect to — always the instance's own origin (frontend.md K1). */
export function mcpEndpointUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/**
 * How MCP clients authenticate on this instance, and how we know. `/ai/status` is authoritative
 * (`mcp.auth`: OAuth on an HTTPS issuer, personal tokens on a plain-HTTP `lan` instance); when it cannot
 * be read (an older API, an error) the page falls back to the scheme it was loaded over, and says so.
 */
export function mcpConnectionMode(
  statusAuth: AiMcpAuthMode | undefined,
  protocol: string,
): { mode: AiMcpAuthMode; source: "status" | "browser" } {
  if (statusAuth === "oauth" || statusAuth === "personal-token") {
    return { mode: statusAuth, source: "status" };
  }
  return {
    mode: protocol === "https:" ? "oauth" : "personal-token",
    source: "browser",
  };
}

/* ─────────────────────────────── the MCP client allowlist ─────────────────────────────── */

export type AllowlistMatchKind = McpClientAllowlistEntry["match"]["kind"];

/** Why an allowlist value is refused, as a key under `aiSettings.mcp.allowlist.errors`. */
export type AllowlistValueProblem =
  | "labelRequired"
  | "valueRequired"
  | "cimdHttps"
  | "userinfo"
  | "httpNotLoopback"
  | "browserScheme"
  | "redirectInvalid";

/**
 * Early feedback on an allowlist entry, from the shared `classifyMcpRedirectUri` contract (the API runs
 * the same schema on save): a CIMD client id must be `https://`; a redirect URI must be https, loopback
 * http, or a private-use scheme — never userinfo (`user@host`), plain http off loopback, or a
 * browser-interpreted scheme.
 */
export function allowlistValueProblem(
  kind: AllowlistMatchKind,
  label: string,
  value: string,
): AllowlistValueProblem | null {
  if (label.trim() === "") return "labelRequired";
  const trimmed = value.trim();
  if (trimmed === "") return "valueRequired";
  if (kind === "cimd_url") {
    return /^https:\/\/\S+$/i.test(trimmed) ? null : "cimdHttps";
  }
  if (classifyMcpRedirectUri(trimmed) !== null) return null;
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(trimmed)?.[1];
  if (authority?.includes("@")) return "userinfo";
  if (/^http:\/\//i.test(trimmed)) return "httpNotLoopback";
  if (/^(javascript|data|file|blob|about|view-source|vbscript|filesystem):/i.test(trimmed)) {
    return "browserScheme";
  }
  return "redirectInvalid";
}

/**
 * A stable id for an admin entry, derived from its label. Always `admin-…`, so it can never collide
 * with a curated default's id (the API would silently ignore an admin entry that did), and unique among
 * `taken`.
 */
export function allowlistEntryId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "client";
  const base = `admin-${slug}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The admin entry for a new client, validated against the shared schema — or the problem that stops
 * it. `existing` are the admin's current entries (their ids are reserved).
 */
export function buildAllowlistEntry(
  kind: AllowlistMatchKind,
  label: string,
  value: string,
  existing: readonly McpClientAllowlistEntry[],
): { entry: McpClientAllowlistEntry } | { problem: AllowlistValueProblem } {
  const problem = allowlistValueProblem(kind, label, value);
  if (problem) return { problem };
  const id = allowlistEntryId(label, existing.map((entry) => entry.id));
  const candidate = {
    id,
    label: label.trim(),
    match:
      kind === "cimd_url"
        ? { kind, url: value.trim() }
        : { kind, pattern: value.trim() },
  };
  const parsed = McpClientAllowlistEntrySchema.safeParse(candidate);
  return parsed.success ? { entry: parsed.data } : { problem: "redirectInvalid" };
}

/** The value an entry matches on, for display. */
export function allowlistEntryValue(entry: McpClientAllowlistEntry): string {
  return entry.match.kind === "cimd_url" ? entry.match.url : entry.match.pattern;
}

/** A redirect entry's kind (`https` / `loopback` / `private-use`), for the badge; null for a CIMD entry. */
export function allowlistEntryRedirectKind(entry: McpClientAllowlistEntry) {
  return entry.match.kind === "redirect_uri"
    ? classifyMcpRedirectUri(entry.match.pattern)
    : null;
}

/* ─────────────────────────────── numbers ─────────────────────────────── */

/** A positive integer typed into a field, or null when blank or not a positive integer. */
export function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647
    ? value
    : null;
}

/* ─────────────────────────────── the connection draft ─────────────────────────────── */

/**
 * The connection fields as the admin edits them (strings for the inputs). Shared by the wizard and the
 * editor; {@link draftToPatch} and {@link draftToTest} turn it into the wire shapes.
 */
export interface ConnectionDraft {
  provider: AiProviderKind;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  /** Typed in this session only; never pre-filled (the read never carries the key). */
  apiKey: string;
  model: string;
  effort: AiEffort | null;
  /** OpenAI-compatible only; blank = the server's default. */
  temperature: string;
}

/** The draft a saved configuration opens with (the key field always blank). */
export function draftFromSettings(
  settings: AiSettings,
  fallbackProvider: AiProviderKind = "anthropic",
): ConnectionDraft {
  const provider = settings.provider ?? fallbackProvider;
  const descriptor = AI_PROVIDER_DESCRIPTORS[provider];
  return {
    provider,
    baseUrl: settings.baseUrl ?? descriptor.defaultBaseUrl ?? "",
    allowPrivateNetwork: settings.allowPrivateNetwork,
    apiKey: "",
    model: settings.model ?? descriptor.suggestedModel ?? "",
    effort: settings.effort,
    temperature:
      settings.providerOptions?.temperature !== undefined
        ? String(settings.providerOptions.temperature)
        : "",
  };
}

/**
 * The draft after picking another provider: provider-specific fields reset to that provider's
 * defaults, and the typed key dropped (a key belongs to one destination).
 */
export function switchProvider(
  draft: ConnectionDraft,
  provider: AiProviderKind,
  settings: AiSettings,
): ConnectionDraft {
  if (provider === draft.provider) return draft;
  const descriptor = AI_PROVIDER_DESCRIPTORS[provider];
  const backToSaved = provider === settings.provider;
  return {
    ...draft,
    provider,
    apiKey: "",
    baseUrl: backToSaved ? (settings.baseUrl ?? "") : (descriptor.defaultBaseUrl ?? ""),
    allowPrivateNetwork: backToSaved ? settings.allowPrivateNetwork : false,
    model: backToSaved
      ? (settings.model ?? descriptor.suggestedModel ?? "")
      : (descriptor.suggestedModel ?? ""),
    temperature: backToSaved ? draftFromSettings(settings).temperature : "",
  };
}

/** The temperature as a number in [0, 2], `undefined` when blank, or `NaN` when unusable. */
export function parseTemperature(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : Number.NaN;
}

function providerOptionsOf(draft: ConnectionDraft): AiProviderOptions | null {
  if (draft.provider !== "openai-compatible") return null;
  const temperature = parseTemperature(draft.temperature);
  return temperature === undefined || Number.isNaN(temperature) ? null : { temperature };
}

/**
 * The connection part of a `PUT /config/ai` for this draft. The key travels only when typed; a base URL
 * and the private-network option only for the OpenAI-compatible provider (the other SDKs use their own
 * endpoint).
 */
export function draftToPatch(draft: ConnectionDraft): Partial<UpdateAiSettings> {
  const compatible = draft.provider === "openai-compatible";
  const patch: Partial<UpdateAiSettings> = {
    provider: draft.provider,
    model: blankToNull(draft.model),
    baseUrl: compatible ? blankToNull(draft.baseUrl) : null,
    allowPrivateNetwork: compatible && draft.allowPrivateNetwork,
    effort: draft.effort,
    providerOptions: providerOptionsOf(draft),
  };
  const key = draft.apiKey.trim();
  if (key !== "") patch.apiKey = key;
  return patch;
}

/** The `POST /config/ai/test` draft for these fields (the saved key is used when none is typed). */
export function draftToTest(draft: ConnectionDraft): AiConnectionDraft {
  const patch = draftToPatch(draft);
  const body: AiConnectionDraft = {
    provider: draft.provider,
    baseUrl: patch.baseUrl ?? null,
    allowPrivateNetwork: patch.allowPrivateNetwork,
    providerOptions: patch.providerOptions ?? null,
  };
  if (patch.model) body.model = patch.model;
  if (patch.apiKey) body.apiKey = patch.apiKey;
  return body;
}
