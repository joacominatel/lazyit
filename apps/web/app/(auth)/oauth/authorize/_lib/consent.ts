import type {
  OAuthAuthorizeParams,
  OAuthAuthorizeRefusal,
  OAuthScope,
} from "@lazyit/shared";
import { OAUTH_AUTHORIZE_REFUSALS } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

/**
 * Pure logic of the OAuth consent page (`/oauth/authorize`; docs/ai-assistant/frontend.md §5.3,
 * mcp-and-oauth.md §5.2 and §12). React-free so it is unit-tested with `bun test` (ADR-0012).
 *
 * The API decides everything (it re-validates the raw parameters on the decision); these helpers only
 * decide what the page draws and where — if anywhere — it may send the browser.
 */

/** The authorization-request parameters the page forwards, and nothing else. */
const AUTHORIZE_PARAM_KEYS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const satisfies readonly (keyof OAuthAuthorizeParams)[];

/** Next.js `searchParams` as a page receives them. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the authorization-request parameters from the page's query. Only the known OAuth keys are
 * forwarded (anything else is dropped). A parameter sent twice is refused here (RFC 6749 §3.1) — the
 * page renders an error and never redirects. Missing parameters are left out: the API decides whether
 * the request is recoverable (a redirect back to the client) or not (an error page).
 */
export function readAuthorizeParams(
  searchParams: RawSearchParams,
):
  | { ok: true; params: OAuthAuthorizeParams }
  | { ok: false; reason: "repeated" } {
  const params: Partial<Record<(typeof AUTHORIZE_PARAM_KEYS)[number], string>> =
    {};
  for (const key of AUTHORIZE_PARAM_KEYS) {
    const value = searchParams[key];
    if (Array.isArray(value)) return { ok: false, reason: "repeated" };
    if (typeof value === "string") params[key] = value;
  }
  // The API validates shape and meaning; the cast only states which keys may be present.
  return { ok: true, params: params as OAuthAuthorizeParams };
}

/** The consent screen's everyday access choice. */
export type AccessLevel = "read" | "write";

/** What the consent screen offers for a set of requested scopes. */
export interface ConsentChoices {
  /** The access levels the client asked for, in display order. */
  levels: AccessLevel[];
  /** The preselected level: "write" when asked for, otherwise "read"; null when neither was asked. */
  defaultLevel: AccessLevel | null;
  /** `lazyit.admin` was requested — offered as an explicit extra, NEVER preselected. */
  adminOffered: boolean;
}

/** The choices for the scopes the client requested (the user may only narrow them). */
export function consentChoices(requested: readonly OAuthScope[]): ConsentChoices {
  const levels: AccessLevel[] = [];
  if (requested.includes("lazyit.read")) levels.push("read");
  if (requested.includes("lazyit.write")) levels.push("write");
  return {
    levels,
    defaultLevel: levels.includes("write")
      ? "write"
      : levels.includes("read")
        ? "read"
        : null,
    adminOffered: requested.includes("lazyit.admin"),
  };
}

/**
 * The scopes to grant for the user's choice — always a subset of what was requested.
 * "read" grants `lazyit.read`; "write" grants the requested read/write scopes (write implies read at
 * the MCP listing). `lazyit.admin` is added only when the user ticked it AND it was requested.
 */
export function scopesToGrant(
  requested: readonly OAuthScope[],
  level: AccessLevel | null,
  admin: boolean,
): OAuthScope[] {
  const granted: OAuthScope[] = [];
  if (level === "read" && requested.includes("lazyit.read")) {
    granted.push("lazyit.read");
  }
  if (level === "write") {
    if (requested.includes("lazyit.read")) granted.push("lazyit.read");
    if (requested.includes("lazyit.write")) granted.push("lazyit.write");
  }
  if (admin && requested.includes("lazyit.admin")) granted.push("lazyit.admin");
  return granted;
}

/** Schemes the page never navigates to, whatever the API answers (defence in depth). */
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
]);

/**
 * Whether `redirectTo` (from the API) is a redirect back to the client's registered `redirectUri`: the
 * same scheme, host (with port) and path, only the query differing (it carries `code`, `state`, `iss`
 * or `error`). A custom scheme is allowed (Cursor registers `cursor://…`) — never a script-capable one.
 * Anything else — a different host, an unparseable value — is refused and the page shows an error.
 */
export function isRedirectToClient(
  redirectTo: unknown,
  redirectUri: string | undefined,
): redirectTo is string {
  if (typeof redirectTo !== "string" || typeof redirectUri !== "string") {
    return false;
  }
  let target: URL;
  let registered: URL;
  try {
    target = new URL(redirectTo);
    registered = new URL(redirectUri);
  } catch {
    return false;
  }
  if (FORBIDDEN_SCHEMES.has(target.protocol)) return false;
  if (target.username || target.password || target.hash) return false;
  return (
    target.protocol === registered.protocol &&
    target.host === registered.host &&
    target.pathname === registered.pathname
  );
}

/** What went wrong with `POST /oauth/authorize/validate`, as the page renders it. */
export type ValidateFailure =
  /** No authorization server here (404): a plain-HTTP `lan` instance, or no HTTPS address configured. */
  | { kind: "unavailable" }
  /** A request error that belongs to the client: offer (never auto-follow) the way back. */
  | { kind: "client-error"; error: string; redirectTo: string }
  /** A malformed request the client cannot be told about (no redirect). */
  | { kind: "invalid-request" }
  /** The session is dead: sign in again and come back. */
  | { kind: "auth" }
  /** Local mode: the account must change its password first. */
  | { kind: "password-change" }
  | { kind: "unknown"; requestId?: string };

function bodyOf(error: ApiError): Record<string, unknown> {
  return error.body && typeof error.body === "object"
    ? (error.body as Record<string, unknown>)
    : {};
}

/**
 * Classify a failed validate call. A `400 { error, redirectTo }` is offered as a link back to the
 * client only when {@link isRedirectToClient} accepts it against the request's own `redirect_uri`.
 */
export function classifyValidateError(
  error: unknown,
  redirectUri: string | undefined,
): ValidateFailure {
  if (!(error instanceof ApiError)) return { kind: "unknown" };
  const body = bodyOf(error);
  if (error.status === 404) return { kind: "unavailable" };
  if (error.status === 401) return { kind: "auth" };
  if (error.status === 403 && body.code === "PASSWORD_CHANGE_REQUIRED") {
    return { kind: "password-change" };
  }
  if (error.status === 400) {
    if (
      typeof body.error === "string" &&
      isRedirectToClient(body.redirectTo, redirectUri)
    ) {
      return {
        kind: "client-error",
        error: body.error,
        redirectTo: body.redirectTo,
      };
    }
    return { kind: "invalid-request" };
  }
  return { kind: "unknown", requestId: error.requestId };
}

/** What happened to `POST /oauth/authorize/decision`, as the page reacts to it. */
export type DecisionOutcome =
  /** Go back to the client (a code, `access_denied`, or a client-owned request error). */
  | { kind: "redirect"; redirectTo: string }
  /** Refused before any redirect: show why, never redirect. */
  | { kind: "refusal"; refusal: OAuthAuthorizeRefusal }
  /** The admin scope needs the password (none was sent). Not a logout. */
  | { kind: "step-up-required" }
  /** The password was wrong. Not a logout. */
  | { kind: "step-up-failed" }
  /** This account has no lazyit password (sign-in mode): the admin scope cannot be granted. */
  | { kind: "step-up-unavailable" }
  | { kind: "rate-limited" }
  /** A redirect the page will not follow (it does not point back at the registered redirect). */
  | { kind: "unsafe-redirect" }
  | { kind: "unknown"; requestId?: string };

function isRefusal(value: unknown): value is OAuthAuthorizeRefusal {
  return (OAUTH_AUTHORIZE_REFUSALS as readonly unknown[]).includes(value);
}

/** Classify a successful decision response (`{ redirectTo }`). */
export function classifyDecisionSuccess(
  response: unknown,
  redirectUri: string | undefined,
): DecisionOutcome {
  const redirectTo = (response as { redirectTo?: unknown } | null | undefined)
    ?.redirectTo;
  return isRedirectToClient(redirectTo, redirectUri)
    ? { kind: "redirect", redirectTo }
    : { kind: "unsafe-redirect" };
}

/** Classify a failed decision call. None of the 403s here means the session ended. */
export function classifyDecisionError(
  error: unknown,
  redirectUri: string | undefined,
): DecisionOutcome {
  if (!(error instanceof ApiError)) return { kind: "unknown" };
  const body = bodyOf(error);
  if (error.status === 400 && "redirectTo" in body) {
    return isRedirectToClient(body.redirectTo, redirectUri)
      ? { kind: "redirect", redirectTo: body.redirectTo }
      : { kind: "unsafe-redirect" };
  }
  if (error.status === 403) {
    if (isRefusal(body.refusal)) return { kind: "refusal", refusal: body.refusal };
    if (body.code === "STEP_UP_REQUIRED") return { kind: "step-up-required" };
    if (body.code === "STEP_UP_FAILED") return { kind: "step-up-failed" };
    if (body.code === "STEP_UP_UNAVAILABLE") {
      return { kind: "step-up-unavailable" };
    }
  }
  if (error.status === 429) return { kind: "rate-limited" };
  return { kind: "unknown", requestId: error.requestId };
}
