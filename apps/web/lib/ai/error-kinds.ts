import { AI_PREVIEW_WARNING_CODES, AI_RUN_ERROR_CODES } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

/**
 * Error codes → what the chat says and offers (frontend.md §5.6 and K5). Pure; the i18n keys it returns
 * live under `ai.errors.*` and a covering-set test holds every code to a key in both catalogs.
 */

/** What the user can do about a run error. */
export type RecoveryAction = "retry" | "newChat" | "none";

export interface RunErrorKind {
  /** Key under `ai.errors.run`. */
  key: string;
  action: RecoveryAction;
  /** The launcher's status must be re-read (the assistant was turned off or access was lost). */
  refreshStatus: boolean;
}

const RUN_ERROR_ACTIONS: Partial<Record<string, RecoveryAction>> = {
  PROVIDER_RATE_LIMIT: "retry",
  PROVIDER_UNAVAILABLE: "retry",
  ENGINE_RESTART: "retry",
  NETWORK: "retry",
  RATE_LIMITED: "retry",
  CONTEXT_LIMIT: "newChat",
  CONVERSATION_READ_ONLY: "newChat",
  MAX_STEPS: "retry",
};

/** Client-side codes the chat raises itself, beside the run's. */
export const AI_CLIENT_ERROR_CODES = ["NETWORK", "RATE_LIMITED", "EXPIRED"] as const;

/** Every code the web has a message for (the covering set). */
export const KNOWN_RUN_ERROR_CODES: readonly string[] = [
  ...AI_RUN_ERROR_CODES,
  ...AI_CLIENT_ERROR_CODES,
];

export function runErrorKind(code: string | null | undefined): RunErrorKind {
  const known = typeof code === "string" && KNOWN_RUN_ERROR_CODES.includes(code);
  return {
    key: known ? code : "generic",
    action: (known && RUN_ERROR_ACTIONS[code]) || "none",
    refreshStatus: code === "AI_DISABLED" || code === "FORBIDDEN",
  };
}

/** The code and extras of an API refusal body `{ code, message, retryAfterSec?, addedWarnings? }`. */
export interface ApiRefusal {
  status: number;
  code: string | null;
  message: string;
  retryAfterSec: number | null;
  addedWarnings: string[];
  requestId?: string;
}

export function refusalOf(error: unknown): ApiRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const body = (error.body ?? {}) as Record<string, unknown>;
  const retry = body.retryAfterSec;
  const added = body.addedWarnings;
  return {
    status: error.status,
    code: typeof body.code === "string" ? body.code : null,
    message: error.message,
    retryAfterSec: typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? retry : null,
    addedWarnings: Array.isArray(added)
      ? added.filter((w): w is string => typeof w === "string")
      : [],
    requestId: error.requestId,
  };
}

/**
 * What an approval decision's refusal means for the card (frontend.md K5). None of the 403s is a logout:
 * `STEP_UP_*` are about the password only.
 */
export type DecisionErrorKind =
  /** Password needed — none was sent, or a step-up warning appeared since the card was shown. */
  | { kind: "stepUpRequired"; addedWarnings: string[] }
  | { kind: "stepUpFailed" }
  | { kind: "stepUpUnavailable" }
  | { kind: "stepUpRateLimited"; retryAfterSec: number | null }
  /** The card changed under the user: re-read it, highlight the new warnings, decide again. */
  | { kind: "previewChanged"; addedWarnings: string[] }
  /** The run no longer waits (already decided and resumed, cancelled, finished). */
  | { kind: "notAwaiting" }
  | { kind: "aiDisabled" }
  /** The target changed since the proposal; nothing ran and the assistant is told to re-check. */
  | { kind: "stale" }
  | { kind: "expired" }
  /** Decided elsewhere (another tab), or still executing. */
  | { kind: "alreadyDecided" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "unknown"; requestId?: string };

export function decisionErrorKind(error: unknown): DecisionErrorKind {
  const refusal = refusalOf(error);
  if (!refusal) return { kind: "unknown" };
  const { status, code, addedWarnings } = refusal;

  if (status === 403) {
    if (code === "STEP_UP_REQUIRED") return { kind: "stepUpRequired", addedWarnings };
    if (code === "STEP_UP_FAILED") return { kind: "stepUpFailed" };
    if (code === "STEP_UP_UNAVAILABLE") return { kind: "stepUpUnavailable" };
    return { kind: "forbidden" };
  }
  if (status === 429 && code === "STEP_UP_RATE_LIMITED") {
    return { kind: "stepUpRateLimited", retryAfterSec: refusal.retryAfterSec };
  }
  if (status === 409) {
    switch (code) {
      case "PREVIEW_CHANGED":
        return { kind: "previewChanged", addedWarnings };
      case "RUN_NOT_AWAITING_APPROVAL":
        return { kind: "notAwaiting" };
      case "AI_DISABLED":
        return { kind: "aiDisabled" };
      case "STALE":
        return { kind: "stale" };
      case "EXPIRED":
        return { kind: "expired" };
      default:
        // Core's other refusals carry the action's status: REJECTED, CANCELLED, IN_PROGRESS, …
        return { kind: "alreadyDecided" };
    }
  }
  if (status === 404) return { kind: "notFound" };
  return { kind: "unknown", requestId: refusal.requestId };
}

/** Kinds after which the card must be re-read from the server (a fresh `run.snapshot`). */
export function decisionNeedsRefresh(kind: DecisionErrorKind): boolean {
  return (
    kind.kind === "previewChanged" ||
    (kind.kind === "stepUpRequired" && kind.addedWarnings.length > 0) ||
    kind.kind === "notAwaiting" ||
    kind.kind === "stale" ||
    kind.kind === "expired" ||
    kind.kind === "alreadyDecided"
  );
}

/** Every decision kind has a message key `ai.approval.errors.<kind>` (covering set). */
export const DECISION_ERROR_KINDS = [
  "stepUpRequired",
  "stepUpFailed",
  "stepUpUnavailable",
  "stepUpRateLimited",
  "previewChanged",
  "notAwaiting",
  "aiDisabled",
  "stale",
  "expired",
  "alreadyDecided",
  "forbidden",
  "notFound",
  "unknown",
] as const satisfies readonly DecisionErrorKind["kind"][];

/** The warning codes the web localizes; any other renders generically. */
export function isKnownWarning(code: string): boolean {
  return (AI_PREVIEW_WARNING_CODES as readonly string[]).includes(code);
}

/**
 * The warnings that make core ask for the password (the CEO's closed list, documented on
 * `AI_PREVIEW_WARNING_CODES`). Display only — a lock beside the warning; whether the card asks for the
 * password is the server's `stepUpRequired`, and a refusal with `STEP_UP_REQUIRED` always opens the field.
 */
export const STEP_UP_WARNINGS: readonly string[] = [
  "ROLE_CHANGE",
  "IDENTITY_CHANGE",
  "PRIVILEGE_GRANT",
  "CREDENTIAL_DELIVERY",
  "CRITICAL_APPLICATION",
];

/** Maps a failed send / create / delete request to a notice code. */
export function sendErrorCode(error: unknown): string {
  const refusal = refusalOf(error);
  if (!refusal) return "NETWORK";
  return refusal.code ?? "generic";
}
