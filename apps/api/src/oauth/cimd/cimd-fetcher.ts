import {
  EgressError,
  guardedFetch,
  type EgressTransport,
  type DnsLookup,
} from '../../common/egress';
import {
  CIMD_FETCH_DEADLINE_MS,
  CIMD_FETCH_IDLE_TIMEOUT_MS,
  CIMD_MAX_DOCUMENT_BYTES,
} from './cimd.constants';
import { CimdRefusal } from './cimd-document';

/** What a successful fetch yields: the parsed JSON body (not yet validated) and the response headers. */
export interface FetchedDocument {
  body: unknown;
  headers: Headers;
}

/** Test seams for the egress guard; production passes nothing (real DNS, the pinning node transport). */
export interface CimdFetchOptions {
  transport?: EgressTransport;
  lookup?: DnsLookup;
  /** Override of {@link CIMD_FETCH_DEADLINE_MS} (tests only). */
  deadlineMs?: number;
}

/** Statuses that say "try again later" rather than anything about the document (5xx are added too). */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/** `application/json` or any `application/<something>+json`, parameters ignored. */
function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (
    type === 'application/json' ||
    /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(type)
  );
}

/** Read at most `limit` bytes of a body; more than that is a refusal, and the stream is cancelled. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new CimdRefusal(
        'too_large',
        `The document is larger than ${limit} bytes`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * {@link fetchOnce} under ONE total deadline that covers everything — DNS resolution included. The egress
 * guard's own deadline starts at connect; `getaddrinfo` runs before it on the libuv threadpool and cannot be
 * cancelled, so the whole attempt is raced against a timer here: when it fires, the request is aborted
 * (its signal) and the caller gets `fetch_failed` at once, whatever a stuck resolver is still doing.
 */
export async function fetchClientMetadataDocument(
  url: URL,
  options: CimdFetchOptions = {},
): Promise<FetchedDocument> {
  const deadlineMs = options.deadlineMs ?? CIMD_FETCH_DEADLINE_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new CimdRefusal(
          'fetch_failed',
          `The document could not be fetched within ${deadlineMs} ms`,
          true,
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });
  const attempt = fetchOnce(url, options, controller.signal);
  // The losing side of the race must never surface as an unhandled rejection.
  attempt.catch(() => undefined);
  deadline.catch(() => undefined);
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a Client ID Metadata Document — ONLY through the egress guard (INV-MCP-6 / INV-AI-7; security.md
 * T-28, G3 "CIMD: fetched through the egress guard with no private allowlist"):
 *   - `https:` only, userinfo refused; every resolved address must be public — private, loopback, link-local,
 *     IMDS and every other special-use range are denied, and there is NO internal-target allowlist seam;
 *   - the dialed IP is pinned (no DNS rebinding between check and connect);
 *   - redirects are NEVER followed (`maxRedirects: 0` — the draft's "MUST NOT automatically follow HTTP
 *     redirects"): a 3xx is a failure;
 *   - bounded in time — a total deadline that covers DNS resolution too (the caller races it) plus the
 *     guard's idle timeout and connect-to-body deadline — and in size ({@link CIMD_MAX_DOCUMENT_BYTES}, checked on
 *     `Content-Length` and again while reading);
 *   - no credentials, no cookies: a bare GET with `Accept: application/json`.
 * Only a 200 with a JSON media type and a JSON body succeeds. Throws {@link CimdRefusal}.
 */
async function fetchOnce(
  url: URL,
  options: CimdFetchOptions,
  signal: AbortSignal,
): Promise<FetchedDocument> {
  let response: Response;
  try {
    response = await guardedFetch(
      url,
      { method: 'GET', headers: { accept: 'application/json' }, signal },
      {
        allowedProtocols: ['https:'],
        refuseUserinfo: true,
        maxRedirects: 0,
        timeoutMs: CIMD_FETCH_IDLE_TIMEOUT_MS,
        deadlineMs: CIMD_FETCH_DEADLINE_MS,
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.lookup ? { lookup: options.lookup } : {}),
      },
    );
  } catch (err) {
    if (err instanceof EgressError && err.reason === 'too-many-redirects') {
      // A redirect is never followed; it is treated as a network failure because captive portals and
      // intercepting proxies answer that way.
      throw new CimdRefusal('http_status', 'The document URL redirected', true);
    }
    const detail = err instanceof EgressError ? err.reason : 'network error';
    throw new CimdRefusal(
      'fetch_failed',
      `The document could not be fetched (${detail})`,
      true,
    );
  }

  try {
    if (response.status !== 200) {
      throw new CimdRefusal(
        'http_status',
        `The document URL answered ${response.status}`,
        TRANSIENT_STATUSES.has(response.status) || response.status >= 500,
      );
    }
    if (!isJsonMediaType(response.headers.get('content-type'))) {
      // A non-JSON page is what a captive portal or an intercepting proxy serves: a network failure.
      throw new CimdRefusal(
        'content_type',
        'The document is not served as JSON',
        true,
      );
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > CIMD_MAX_DOCUMENT_BYTES) {
      throw new CimdRefusal(
        'too_large',
        `The document is larger than ${CIMD_MAX_DOCUMENT_BYTES} bytes`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, CIMD_MAX_DOCUMENT_BYTES);
    } catch (err) {
      if (err instanceof CimdRefusal) throw err;
      throw new CimdRefusal(
        'fetch_failed',
        'The document could not be read',
        true,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new CimdRefusal('malformed', 'The document is not valid JSON');
    }
    return { body, headers: response.headers };
  } finally {
    // Release the socket whatever happened (a no-op once the body was fully read).
    if (response.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}
