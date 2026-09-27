import type { AiProviderKind } from '@lazyit/shared';

import {
  assertUrlAllowed,
  defaultDnsLookup,
  EgressError,
  guardedFetch,
  isPublicCategory,
  type DnsLookup,
  type EgressTransport,
  type GuardedFetchOptions,
  type InternalTargetContext,
} from '../../common/egress';
import type { FetchLike } from './provider.types';

/**
 * The only way provider HTTP leaves the instance (INV-AI-7; provider-and-runtime.md §9.2; security.md
 * §6.4). Every model step, model listing and connection probe is given this `fetch`, which runs the
 * egress guard with the provider policy:
 *
 * - HTTPS only, and **no redirects** (`maxRedirects: 0` — a 3xx is refused, never followed).
 * - Long LLM timeouts, always both of them: without an explicit total `deadlineMs` the node transport
 *   falls back to the idle timeout and cuts long generations mid-body (W1-B finding 3).
 * - Private addresses are denied, with ONE exception: the OpenAI-compatible provider, when the admin
 *   turned `allowPrivateNetwork` on, may reach a private (RFC1918 / ULA) address of exactly the configured
 *   base-URL host and port. Plain `http:` is accepted only for that host and only when it resolves to a
 *   private address. Loopback, IMDS, link-local and the other hard-denied ranges stay unreachable: the
 *   guard never routes them through the allowlist seam.
 *
 * - Every response body is capped at {@link PROVIDER_RESPONSE_MAX_BYTES}, 2xx streams and error bodies
 *   alike (security.md §6.4): past it the body stream errors with {@link ProviderResponseTooLargeError}
 *   and the upstream is cancelled, so a hostile or broken endpoint cannot make the api buffer without end.
 *
 * Nothing here logs, and the request headers (which carry the key) are never copied anywhere.
 */

/** Idle timeout per socket: reasoning models can pause for a long time between tokens. */
export const PROVIDER_IDLE_TIMEOUT_MS = 120_000;
/** Total budget for one model step, connect to last byte. */
export const PROVIDER_DEADLINE_MS = 600_000;

/**
 * The largest response body read from a provider, per request. A step's SSE stream is the big case: the
 * framing costs roughly 100–200 bytes per delta event, so 32 MiB covers well over 100k streamed output
 * tokens (more than any `maxOutputTokens` lazyit sends), while bounding the api's memory at the ai-run
 * worker concurrency (4 × 32 MiB against the 768 MiB container).
 */
export const PROVIDER_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/** The body of a provider response exceeded {@link PROVIDER_RESPONSE_MAX_BYTES}. */
export class ProviderResponseTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`The provider response exceeded ${maxBytes} bytes`);
    this.name = 'ProviderResponseTooLargeError';
    this.maxBytes = maxBytes;
    Object.setPrototypeOf(this, ProviderResponseTooLargeError.prototype);
  }
}

/** The same response, its body counted and errored past `maxBytes` (the upstream is then cancelled). */
export function capResponseBody(
  response: Response,
  maxBytes: number,
): Response {
  if (!response.body) {
    return response;
  }
  let received = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          controller.error(new ProviderResponseTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Where a provider is allowed to go, derived from the settings. */
export interface ProviderEgressTarget {
  kind: AiProviderKind;
  baseUrl: string | null;
  allowPrivateNetwork: boolean;
}

/** Test seams: the resolver and the transport of the egress guard. Production passes neither. */
export interface ProviderFetchOverrides {
  lookup?: DnsLookup;
  transport?: EgressTransport;
  /** Response cap (default {@link PROVIDER_RESPONSE_MAX_BYTES}). */
  maxResponseBytes?: number;
}

/** Builds the `fetch` for one provider target (injectable so specs can script the upstream). */
export type ProviderFetchFactory = (
  target: ProviderEgressTarget,
  overrides?: ProviderFetchOverrides,
) => FetchLike;

interface PrivateHostScope {
  hostname: string;
  port: number;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * The single private host this target may reach, or `null`. Only the OpenAI-compatible provider, only with
 * the admin toggle on, and only the configured base URL's own host and port.
 */
export function privateHostScope(
  target: ProviderEgressTarget,
): PrivateHostScope | null {
  if (
    target.kind !== 'openai-compatible' ||
    !target.allowPrivateNetwork ||
    !target.baseUrl
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(target.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  return {
    hostname: stripBrackets(url.hostname).toLowerCase(),
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
  };
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === 'string') {
    return new URL(input);
  }
  return new URL(input.url);
}

export const createProviderFetch: ProviderFetchFactory = (
  target,
  overrides = {},
) => {
  const scope = privateHostScope(target);
  const isInternalTargetAllowed = (ctx: InternalTargetContext): boolean =>
    scope !== null &&
    ctx.hostname.toLowerCase() === scope.hostname &&
    ctx.port === scope.port;

  const base: GuardedFetchOptions = {
    allowedProtocols: ['https:'],
    isInternalTargetAllowed,
    maxRedirects: 0,
    timeoutMs: PROVIDER_IDLE_TIMEOUT_MS,
    deadlineMs: PROVIDER_DEADLINE_MS,
    lookup: overrides.lookup ?? defaultDnsLookup,
    transport: overrides.transport,
  };

  return async (input, init) => {
    const url = requestUrl(input);
    let options = base;

    if (url.protocol === 'http:' && scope !== null) {
      // Cleartext only toward the scoped private host: resolve once, require every address to be
      // non-public (the guard then requires private + the allowlisted host), and pin the dial to exactly
      // the addresses checked here, so a re-resolution cannot swap in a public address.
      const cleartext: GuardedFetchOptions = {
        ...base,
        allowedProtocols: ['http:'],
      };
      const resolved = await assertUrlAllowed(url, cleartext);
      if (resolved.addresses.some((a) => isPublicCategory(a.category))) {
        throw new EgressError(
          'scheme-not-allowed',
          'Cleartext http is allowed only toward the private provider host',
          { url: url.href },
        );
      }
      const pinned = resolved.addresses.map((a) => ({
        address: a.address,
        family: a.family,
      }));
      options = { ...cleartext, lookup: () => Promise.resolve(pinned) };
    }

    const response = await guardedFetch(url, init ?? {}, options);
    return capResponseBody(
      response,
      overrides.maxResponseBytes ?? PROVIDER_RESPONSE_MAX_BYTES,
    );
  };
};
