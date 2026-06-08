import { EgressError } from '../../common/egress';

/**
 * Shared outbound-HTTP support for the REST + WEBHOOK_OUT handlers: URL assembly, correlation-id
 * capture, and the classification of a thrown transport/guard error into REDACTED failure metadata.
 * Kept logic-only and secret-free (INV-6) — nothing here logs or returns a body / credential.
 */

/** Default per-call timeout when the step/run does not override it. */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

/** Cap on the response bytes we will read to capture a correlation id (a small DoS guard). */
export const MAX_CORRELATION_BODY_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` of a (possibly untrusted, possibly multi-GB) response body WITHOUT ever
 * buffering the whole thing (SEC-A2). Two layers:
 *   1. Short-circuit on a declared `Content-Length` that already exceeds the cap — refuse to read,
 *      cancelling the stream so the socket is released.
 *   2. Stream the body chunk-by-chunk with a running byte counter; the moment the total would exceed
 *      `maxBytes` we ABORT (cancel the stream) and give up — never `Response.text()` on an untrusted
 *      stream, which would buffer the entire body before any size check.
 *
 * Returns the decoded text, or `null` when there is no readable body / it is over the cap / a read
 * error occurs. NEVER throws and NEVER logs the body.
 */
async function readCappedBodyText(
  res: Response,
  maxBytes: number,
): Promise<string | null> {
  // (1) A declared length over the cap → don't even start reading.
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* best-effort socket release */
      }
      return null;
    }
  }

  const body = res.body;
  if (!body) {
    return null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      // (2) Over the cap mid-stream → abort the read; never retain the offending chunk.
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  if (chunks.length === 0) {
    return null;
  }
  const buf = Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
  );
  return buf.toString('utf8');
}

/**
 * Allowlisted top-level JSON keys we treat as the external correlation id, in priority order
 * (the created external account/resource id — Jira `accountId`, GitHub `id`, …).
 */
const CORRELATION_KEYS = [
  'id',
  'userId',
  'accountId',
  'externalId',
  'sub',
  'uuid',
  'key',
] as const;

/**
 * Join a connection `baseUrl` with a (already-rendered, relative) step `path`. The HOST is fixed by
 * the config's baseUrl and is never templatable (anti-SSRF, ADR-0054 §6.4); only the path is appended,
 * with slashes normalized. Rendered placeholders in `path` are already percent-encoded by the mapper,
 * so a ctx value can never inject a new path segment / change the origin.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (!path) {
    return base;
  }
  // A query-only path (`?a=1`) attaches directly; otherwise normalize a single separating slash.
  if (path.startsWith('?') || path.startsWith('#')) {
    return `${base}${path}`;
  }
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/** The hostname of a URL (never the full URL with query, which can carry secrets). Best-effort. */
export function redactHost(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Capture the external correlation id from a response: first a `Location` header (a created resource),
 * then a small allowlist of top-level JSON id keys (size-capped read). Returns `null` when none is
 * found. NEVER logs the body. (A per-config response selector is a future enhancement once the step
 * schema carries a `responseExtract` field; v1 uses these safe conventions.)
 */
export async function extractCorrelationId(
  res: Response,
): Promise<string | null> {
  const location = res.headers.get('location');
  if (location) {
    return location;
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return null;
  }
  const text = await readCappedBodyText(res, MAX_CORRELATION_BODY_BYTES);
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of CORRELATION_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

/** A classified failure: the redacted metadata fields + whether it is a transient (retryable) error. */
export interface ClassifiedFailure {
  errorClass: string;
  reason: string;
  /** Whether the underlying failure is TRANSIENT (a transport blip) vs permanent (e.g. egress block). */
  transient: boolean;
}

/**
 * Classify a thrown error from {@link import('../../common/egress').guardedFetch} into redacted
 * failure metadata. An {@link EgressError} (blocked target, bad scheme, too many redirects) is
 * PERMANENT — retrying a misconfigured/blocked URL never helps. A transport timeout is transient; any
 * other network/transport error is transient by nature (DNS blip, connection reset). NEVER includes a
 * body or secret.
 */
export function classifyThrownError(err: unknown): ClassifiedFailure {
  if (err instanceof EgressError) {
    return {
      errorClass: 'egress-blocked',
      reason: `egress guard: ${err.reason}`,
      transient: false,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = /timed? ?out/i.test(message);
  return {
    errorClass: isTimeout ? 'timeout' : 'network',
    reason: isTimeout
      ? 'outbound request timed out'
      : 'network/transport error',
    transient: true,
  };
}

/** Coarse, non-secret HTTP failure class for a non-2xx status (`http-4xx` / `http-5xx`). */
export function httpErrorClass(status: number): string {
  if (status >= 500) {
    return 'http-5xx';
  }
  if (status >= 400) {
    return 'http-4xx';
  }
  return 'http-other';
}
