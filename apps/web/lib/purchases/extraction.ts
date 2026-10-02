/**
 * Document extraction on the web (ADR-0099 §11, #1477) — when the *Read this document* action is offered,
 * and how a refusal or a warning reads. Pure, so it is tested without React.
 *
 * The API is the gate: `GET /purchase-orders/extraction/status` says whether this caller can extract now and
 * which document types the configured provider reads. The web never calls the extract route unless that read
 * says `available` and the document is one of those types, within the size cap.
 */

import type { Attachment, PurchaseExtractionErrorCode, PurchaseExtractionStatus } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

type StatusCaps = Pick<PurchaseExtractionStatus, "mediaTypes" | "maxBytes" | "maxBytesByMediaType">;

/**
 * The largest file of `mediaType` the provider takes: the overall cap, or less where the provider takes less
 * for that type (Anthropic images). An older API without the per-type caps reports only the overall one.
 */
export function maxBytesFor(status: Pick<StatusCaps, "maxBytes" | "maxBytesByMediaType">, mediaType: string): number {
  const type = mediaType.trim().toLowerCase();
  const own = Object.entries(status.maxBytesByMediaType ?? {}).find(([key]) => key.toLowerCase() === type)?.[1];
  return own === undefined ? status.maxBytes : Math.min(status.maxBytes, own);
}

/** Whether `attachment` can be read now: extraction available, a type the provider reads, within its cap. */
export function canExtract(
  status: (Pick<PurchaseExtractionStatus, "available"> & StatusCaps) | undefined,
  attachment: Pick<Attachment, "mimeType" | "byteSize">,
): boolean {
  if (!status?.available) return false;
  return fileProblem(status, { type: attachment.mimeType, size: attachment.byteSize }) === null;
}

/**
 * Whether a file picked for *New purchase from a document* can be read: the same checks before anything is
 * created. `"type"` / `"size"` say why not (the size against {@link maxBytesFor} its type); `null` = fine.
 */
export function fileProblem(status: StatusCaps, file: { type: string; size: number }): "type" | "size" | null {
  const type = file.type.trim().toLowerCase();
  if (!status.mediaTypes.some((t) => t.toLowerCase() === type)) return "type";
  return file.size > maxBytesFor(status, type) ? "size" : null;
}

/** The unavailable reasons an admin can act on in Settings → AI → their key under `purchases.extraction.off`. */
const ACTIONABLE_REASONS: Record<string, string> = {
  AI_DISABLED: "aiDisabled",
  EXTRACTION_DISABLED: "extractionDisabled",
  PROVIDER_UNSUPPORTED: "providerUnsupported",
};

/**
 * The one-line reason shown where the action would be, or `null` to show nothing. Only an admin (who can
 * change Settings → AI) is told why; for anyone else, and for `NOT_PERMITTED` or a reason a newer API adds,
 * the action is simply absent — a hint nobody can act on is noise.
 */
export function unavailableHint(reason: string | null | undefined, isAdmin: boolean): string | null {
  if (!isAdmin || !reason) return null;
  return Object.hasOwn(ACTIONABLE_REASONS, reason) ? ACTIONABLE_REASONS[reason]! : null;
}

/**
 * Every shared refusal code → its key under `purchases.extraction.errors`. Typed over the whole shared list,
 * so a code added there fails the build here until it has copy.
 */
const ERROR_KEYS: Record<PurchaseExtractionErrorCode, string> = {
  AI_DISABLED: "aiDisabled",
  EXTRACTION_DISABLED: "extractionDisabled",
  PROVIDER_UNSUPPORTED: "providerUnsupported",
  NOT_PERMITTED: "notPermitted",
  UNSUPPORTED_MEDIA_TYPE: "unsupportedType",
  DOCUMENT_TOO_LARGE: "tooLarge",
  TOO_MANY_PAGES: "tooManyPages",
  DOCUMENT_UNAVAILABLE: "documentUnavailable",
  BUDGET_EXCEEDED: "budget",
  EXTRACTION_UNREADABLE: "unreadable",
  EXTRACTION_TIMEOUT: "timeout",
  EXTRACTION_IN_PROGRESS: "inProgress",
  RATE_LIMITED: "rateLimited",
};

/** The provider's own failures, passed through on a `502`. */
const PROVIDER_KEYS: Record<string, string> = {
  PROVIDER_AUTH: "providerAuth",
  PROVIDER_RATE_LIMIT: "providerRateLimit",
  PROVIDER_REFUSED: "providerRefused",
  CONTEXT_LIMIT: "contextLimit",
  PROVIDER_UNAVAILABLE: "provider",
  PROVIDER_BAD_REQUEST: "provider",
  EGRESS_DENIED: "provider",
};

/** A code-less (or unknown-code) refusal, told apart by its status. */
const STATUS_KEYS: Record<number, string> = {
  409: "unavailable",
  422: "document",
  429: "rateLimited",
  502: "provider",
  504: "timeout",
  403: "forbidden",
  404: "notFound",
};

/** Every `purchases.extraction.errors` key {@link extractionErrorKey} can return (the covering-set test). */
export const EXTRACTION_ERROR_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(ERROR_KEYS),
    ...Object.values(PROVIDER_KEYS),
    ...Object.values(STATUS_KEYS),
    "generic",
    "network",
  ]),
];

/**
 * A failed extract → its message key under `purchases.extraction.errors`. The stable `code` decides; an
 * unknown code (a newer API) or a code-less body falls back to the status. Nothing was saved on any of them,
 * and the document stays attached — the screen says so next to the message.
 */
export function extractionErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  const body = error.body !== null && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
  const code = typeof body.code === "string" ? body.code : null;
  if (code !== null && Object.hasOwn(ERROR_KEYS, code)) return ERROR_KEYS[code as PurchaseExtractionErrorCode];
  if (code !== null && Object.hasOwn(PROVIDER_KEYS, code)) return PROVIDER_KEYS[code]!;
  return STATUS_KEYS[error.status] ?? "generic";
}

/** The warning codes the web has copy for, under `purchases.extraction.warnings`; any other reads generically. */
const WARNING_KEYS = new Set([
  "AMOUNT_AMBIGUOUS",
  "AMOUNT_UNREADABLE",
  "AMOUNT_TOO_PRECISE",
  "QUANTITY_NOT_WHOLE",
  "DATE_AMBIGUOUS",
  "DATE_UNREADABLE",
  "CURRENCY_AMBIGUOUS",
  "LINE_TOTAL_MISMATCH",
  "TOTAL_MISMATCH",
  "LINES_TRUNCATED",
]);

/** A warning code → its key under `purchases.extraction.warnings` (`"generic"` for a code this build lacks). */
export function warningKey(code: string): string {
  return WARNING_KEYS.has(code) ? code : "generic";
}

/** The longest reference the API stores. */
const REFERENCE_MAX = 200;

/**
 * The reference a purchase created by *New purchase from a document* holds until it is reviewed: the file
 * name without its extension. A purchase must be identifiable to exist (a supplier, a reference or a line —
 * ADR-0099 §2), and extraction reads a document already attached to one, so the file name stands in until
 * the review fills the real reference.
 */
export function referenceFromFileName(name: string): string {
  const trimmed = name.trim();
  const stem = trimmed.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/\s+/g, " ").trim();
  return (stem || trimmed || "Document").slice(0, REFERENCE_MAX);
}

/**
 * Whether the purchase is still only that holder: its reference is the stand-in for this document's name and
 * nothing else identifies it (no supplier, no line). Then the review fills the reference like any empty field
 * — it is not a value a person typed.
 */
export function isDocumentHolder(
  purchase: { reference: string | null; supplierId: string | null; lines: readonly unknown[] },
  attachmentName: string,
): boolean {
  return (
    purchase.supplierId === null &&
    purchase.lines.length === 0 &&
    purchase.reference !== null &&
    purchase.reference === referenceFromFileName(attachmentName)
  );
}

/** The image types the review previews inline (an `<img>` of a `blob:` URL). */
const PREVIEW_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * How the review shows a document next to the draft, from its stored (server-sniffed) type: a PDF as a card
 * that opens it in a new tab (never framed — the CSP keeps `frame-src 'none'`), an image inline, anything else
 * not at all. The bytes are re-typed to exactly this
 * before they get an object URL, so a `blob:` URL of this page's origin can never hold markup.
 */
export function previewKind(mimeType: string): { kind: "pdf" | "image"; type: string } | null {
  const type = mimeType.trim().toLowerCase();
  if (type === "application/pdf") return { kind: "pdf", type };
  return PREVIEW_IMAGES.has(type) ? { kind: "image", type } : null;
}
