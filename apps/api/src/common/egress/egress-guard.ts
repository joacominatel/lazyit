import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Readable } from 'node:stream';

import { classifyIp, isAllowlistableCategory, isPublicCategory } from './ip-rules';
import {
  EgressError,
  type DnsLookup,
  type EgressGuardOptions,
  type EgressTransport,
  type EgressTransportResponse,
  type GuardedFetchOptions,
  type ResolvedAddress,
  type ResolvedTarget,
} from './types';

/**
 * Central, reusable OUTBOUND-HTTP egress guard — the anti-SSRF control every outbound connector MUST
 * route through (workflow-engine security.md §3, INV-WF-2). Defense in depth, in order:
 *
 *   1. SCHEME allowlist via real URL PARSING (`new URL().protocol`), never prefix-sniffing
 *      (the SEC-008 / SEC-051 lesson).
 *   2. Resolve the host ourselves and DENY any resolved address in a private/loopback/link-local/
 *      unique-local/reserved range — including 169.254.169.254 (cloud IMDS) — for IPv4 and IPv6.
 *   3. PIN the validated IP: the returned target names the exact address the socket must dial, and
 *      {@link guardedFetch} dials it via a pinning DNS `lookup`, so the value checked is the value
 *      dialed (defeats DNS rebinding / TOCTOU).
 *   4. RE-VALIDATE on EVERY redirect — {@link guardedFetch} never auto-follows to a blocked target.
 *   5. DENY-PRIVATE-BY-DEFAULT with a documented SEAM ({@link EgressGuardOptions.isInternalTargetAllowed})
 *      for a future per-connector internal-target allowlist. localhost / 127.0.0.1 / ::1 and the IMDS
 *      address are NEVER allowlistable.
 *
 * This module has NO consumer yet (Phase 0). It is not wired into any route or service.
 */

const DEFAULT_PROTOCOLS = ['http:', 'https:'];
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** HTTP statuses that forbid a response body (passing one to `new Response` throws). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Default resolver: `node:dns/promises` `lookup` returning every A/AAAA record in resolver order. */
export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Validate a URL against the full egress policy and return the {@link ResolvedTarget} with the IP to
 * pin. Throws {@link EgressError} on any rejection. Performs DNS resolution; safe to call immediately
 * before each request (and before each redirect hop).
 */
export async function assertUrlAllowed(
  input: string | URL,
  opts: EgressGuardOptions = {},
): Promise<ResolvedTarget> {
  const protocols = opts.allowedProtocols ?? DEFAULT_PROTOCOLS;

  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    throw new EgressError('invalid-url', `Not a valid absolute URL: ${String(input)}`);
  }

  // (1) Scheme allowlist by PARSED protocol — never by prefix-sniffing.
  if (!protocols.includes(url.protocol)) {
    throw new EgressError('scheme-not-allowed', `URL scheme "${url.protocol}" is not allowed`, {
      url: url.href,
    });
  }

  const hostname = stripBrackets(url.hostname);
  if (!hostname) {
    throw new EgressError('empty-host', 'URL has no host component', { url: url.href });
  }
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);

  // (2) Resolve to concrete IP(s). An IP literal needs no DNS; a name is resolved (ourselves).
  let candidates: Array<{ address: string; family: 4 | 6 }>;
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    candidates = [{ address: hostname, family: literalFamily }];
  } else {
    const lookup = opts.lookup ?? defaultDnsLookup;
    try {
      candidates = await lookup(hostname);
    } catch {
      throw new EgressError('dns-resolution-failed', `Could not resolve host "${hostname}"`, {
        url: url.href,
      });
    }
    if (!candidates || candidates.length === 0) {
      throw new EgressError('dns-resolution-failed', `Host "${hostname}" resolved to no addresses`, {
        url: url.href,
      });
    }
  }

  // Validate EVERY resolved address — a host is rejected if any candidate is denied (a name that
  // resolves to both a public and a private/loopback IP is an attack, not a fallback).
  const resolved: ResolvedAddress[] = [];
  for (const candidate of candidates) {
    const category = classifyIp(candidate.address, candidate.family);
    resolved.push({ address: candidate.address, family: candidate.family, category });

    if (isPublicCategory(category)) {
      continue;
    }

    if (isAllowlistableCategory(category)) {
      // (5) Deny-private-by-default — consult the explicit internal-target allowlist seam.
      const allowed = opts.isInternalTargetAllowed
        ? await opts.isInternalTargetAllowed({
            hostname,
            port,
            address: candidate.address,
            family: candidate.family,
            category,
            url,
          })
        : false;
      if (allowed) {
        continue;
      }
      throw new EgressError(
        'blocked-address',
        `Resolved address ${candidate.address} (${category}) is internal and not allowlisted`,
        { url: url.href, address: candidate.address, category },
      );
    }

    // Hard-denied range (loopback / imds / link-local / unspecified / cgnat / multicast / broadcast /
    // reserved) — NEVER allowlistable.
    throw new EgressError(
      'blocked-address',
      `Resolved address ${candidate.address} is in a blocked range (${category})`,
      { url: url.href, address: candidate.address, category },
    );
  }

  // (3) Pin the first validated address — the socket must dial this exact IP.
  const pin = resolved[0];
  return {
    url,
    hostname,
    port,
    address: pin.address,
    family: pin.family,
    category: pin.category,
    addresses: resolved,
  };
}

/** Convenience boolean form of {@link assertUrlAllowed} (swallows the {@link EgressError}). */
export async function isUrlAllowed(input: string | URL, opts: EgressGuardOptions = {}): Promise<boolean> {
  try {
    await assertUrlAllowed(input, opts);
    return true;
  } catch (err) {
    if (err instanceof EgressError) {
      return false;
    }
    throw err;
  }
}

/**
 * Build a Node-style DNS `lookup` that ALWAYS returns the pinned address, ignoring its hostname
 * argument. Wiring this into the socket guarantees the connection dials the exact IP we validated
 * (no second resolution → no DNS-rebinding window).
 */
export function createPinnedLookup(
  address: string,
  family: 4 | 6,
): (
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
) => void {
  return (_hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts as typeof callback;
      opts = {};
    }
    if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
}

/**
 * The default transport: a `node:http` / `node:https` client that dials the PINNED IP (via a pinning
 * `lookup`) while keeping the original hostname for TLS SNI / certificate validation. Returns a
 * lightweight {@link EgressTransportResponse} so {@link guardedFetch} can discard a redirect body
 * without consuming it. Dependency-free (no `undici` import); the returned `toResponse()` yields a
 * standard global `Response`.
 */
export function createNodeTransport(): EgressTransport {
  return (url, req) =>
    new Promise<EgressTransportResponse>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const pinnedLookup = createPinnedLookup(req.pin.address, req.pin.family);

      const request = mod.request(
        url,
        {
          method: req.method,
          headers: req.headers,
          lookup: pinnedLookup as unknown as net.LookupFunction,
          signal: req.signal,
        },
        (res) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) {
              continue;
            }
            if (Array.isArray(value)) {
              for (const v of value) {
                headers.append(key, v);
              }
            } else {
              headers.set(key, String(value));
            }
          }

          const status = res.statusCode ?? 0;
          resolve({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            toResponse: () => {
              const body = NULL_BODY_STATUSES.has(status)
                ? null
                : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
              return new Response(body, { status, statusText: res.statusMessage, headers });
            },
            discard: () => {
              res.resume();
              res.destroy();
            },
          });
        },
      );

      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      request.setTimeout(timeoutMs, () => {
        request.destroy(new EgressError('blocked-address', `Outbound request timed out after ${timeoutMs}ms`, { url: url.href }));
      });
      request.on('error', reject);

      if (req.body !== undefined && req.body !== null) {
        request.write(req.body);
      }
      request.end();
    });
}

function normalizeHeaders(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) {
    return out;
  }
  const headers = new Headers(init);
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * A guarded `fetch`-style wrapper. Validates (and pins) the target before connecting, then follows
 * redirects MANUALLY, re-running the full guard on every `Location` so a `302 → http://169.254.169.254`
 * (the classic SSRF bypass) is rejected instead of auto-followed. Strips `Authorization` / `Cookie` on a
 * cross-origin redirect and drops the body on a 303 (and on 301/302 of a non-GET) per fetch semantics.
 *
 * NOTE: this is the substrate-independent primitive only — it is NOT wired into any route/service yet.
 */
export async function guardedFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const transport = opts.transport ?? createNodeTransport();

  let currentUrl = input instanceof URL ? input : new URL(input);
  let method = (init.method ?? 'GET').toUpperCase();
  let headers = normalizeHeaders(init.headers ?? undefined);
  let body = (init.body ?? undefined) as string | Uint8Array | Buffer | undefined;
  let redirectsLeft = maxRedirects;

  for (;;) {
    // Re-validate on the initial request AND on every redirect hop.
    const target = await assertUrlAllowed(currentUrl, opts);

    const res = await transport(target.url, {
      method,
      headers,
      body: body ?? null,
      pin: { address: target.address, family: target.family },
      signal: init.signal ?? undefined,
      timeoutMs: opts.timeoutMs,
    });

    if (!REDIRECT_STATUSES.has(res.status)) {
      return res.toResponse();
    }

    const location = res.headers.get('location');
    res.discard();
    if (!location) {
      throw new EgressError('redirect-missing-location', `Redirect (${res.status}) without a Location header`, {
        url: target.url.href,
      });
    }
    if (redirectsLeft <= 0) {
      throw new EgressError('too-many-redirects', `Exceeded the redirect limit (${maxRedirects})`, {
        url: target.url.href,
      });
    }
    redirectsLeft -= 1;

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, target.url);
    } catch {
      throw new EgressError('invalid-url', `Redirect Location is not a valid URL: ${location}`, {
        url: target.url.href,
      });
    }

    const crossOrigin = nextUrl.origin !== target.url.origin;
    const downgradeToGet = res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD');
    if (downgradeToGet) {
      method = 'GET';
      body = undefined;
      delete headers['content-length'];
      delete headers['content-type'];
      delete headers['transfer-encoding'];
    }
    if (crossOrigin) {
      delete headers['authorization'];
      delete headers['cookie'];
    }

    currentUrl = nextUrl;
  }
}
