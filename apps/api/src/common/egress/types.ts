import type { AddressCategory } from './ip-rules';

/** Why an outbound request was refused by the egress guard. */
export type EgressDenyReason =
  | 'invalid-url' // not a parseable absolute URL
  | 'scheme-not-allowed' // scheme not in the allowlist (https by default; http opt-in)
  | 'empty-host' // no host component
  | 'dns-resolution-failed' // the hostname did not resolve to any address
  | 'blocked-address' // a resolved address is in a denied range / private-not-allowlisted
  | 'too-many-redirects' // redirect chain exceeded the cap
  | 'redirect-missing-location' // a 3xx response with no usable Location header
  | 'request-timeout' // the per-socket idle timeout fired (no activity within the budget)
  | 'deadline-exceeded'; // the overall total-time budget elapsed (slowloris / trickle guard)

/**
 * The error thrown by every guard rejection. Carries a machine-readable {@link EgressDenyReason} plus
 * (where relevant) the offending url / resolved address / range category, so a future caller can log a
 * precise, non-secret reason. Never embeds request bodies or credentials.
 */
export class EgressError extends Error {
  readonly reason: EgressDenyReason;
  readonly url?: string;
  readonly address?: string;
  readonly category?: AddressCategory;

  constructor(
    reason: EgressDenyReason,
    message: string,
    details?: { url?: string; address?: string; category?: AddressCategory },
  ) {
    super(message);
    this.name = 'EgressError';
    this.reason = reason;
    this.url = details?.url;
    this.address = details?.address;
    this.category = details?.category;
    // Keep `instanceof EgressError` working when targeting ES2015+ / transpiled output.
    Object.setPrototypeOf(this, EgressError.prototype);
  }
}

/** A single resolved candidate address for a host. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
  category: AddressCategory;
}

/**
 * The outcome of a successful {@link assertUrlAllowed}: the parsed URL, the effective host/port, and the
 * **pinned** address (the first resolved candidate) that the socket MUST dial to defeat DNS rebinding.
 * `addresses` lists every candidate that was validated (all of them passed — the guard rejects a host
 * if *any* resolved address is denied).
 */
export interface ResolvedTarget {
  url: URL;
  hostname: string;
  port: number;
  /** The IP the connection must dial (pin) — already validated. */
  address: string;
  family: 4 | 6;
  category: AddressCategory;
  addresses: ResolvedAddress[];
}

/**
 * Context handed to the internal-target allowlist seam. The seam is consulted ONLY for `private`
 * (RFC1918) / `uniqueLocal` (ULA) addresses; loopback, IMDS, link-local and other hard-denied ranges
 * never reach it.
 */
export interface InternalTargetContext {
  hostname: string;
  port: number;
  address: string;
  family: 4 | 6;
  category: AddressCategory;
  url: URL;
}

/**
 * SEAM for a future, per-connector internal-target allowlist (workflow-engine §3.3). Return `true` to
 * permit dialing a private/ULA address. This guard intentionally ships NO storage/UI for it — a real
 * caller wires its audited allowlist here. localhost / 127.0.0.1 / ::1 and the cloud metadata IP are
 * NEVER routed through this function and can never be allowlisted.
 *
 * Default (when omitted): deny-private-by-default.
 */
export type InternalTargetAllowlist = (ctx: InternalTargetContext) => boolean | Promise<boolean>;

/** Resolver abstraction (injectable for tests). Returns every address a hostname resolves to. */
export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

/** Options for {@link assertUrlAllowed}. */
export interface EgressGuardOptions {
  /**
   * Allowed URL schemes (compared against `URL.protocol`, e.g. `'http:'`). Default: HTTPS ONLY
   * (`['https:']`). `http:` is opt-in — a caller that genuinely needs cleartext must request it
   * explicitly (SEC-A4: secure-by-default, no implicit downgrade).
   */
  allowedProtocols?: string[];
  /** The internal-target allowlist seam (see {@link InternalTargetAllowlist}). Default: deny. */
  isInternalTargetAllowed?: InternalTargetAllowlist;
  /** Resolver override (tests / custom DNS). Default: `node:dns/promises` `lookup` with `all: true`. */
  lookup?: DnsLookup;
}

/** A response surface the transport returns, decoupled from the body so redirects can be discarded. */
export interface EgressTransportResponse {
  status: number;
  statusText: string;
  headers: Headers;
  /** Materialize the body into a standard `Response` (call once, for the final hop). */
  toResponse(): Response;
  /** Drain and discard the body without reading it (for an intermediate redirect hop). */
  discard(): void;
}

/** The request the transport receives — already validated, with the IP to pin. */
export interface EgressTransportRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | Buffer | null;
  /** The validated IP the socket MUST dial (pinned to defeat DNS rebinding). */
  pin: { address: string; family: 4 | 6 };
  signal?: AbortSignal;
  /** Per-socket IDLE timeout in ms (resets on activity). Default applied by the transport. */
  timeoutMs?: number;
  /**
   * Overall TOTAL-time budget in ms for the whole attempt (connect → headers → body), independent of
   * the idle timeout. A slowloris/trickle that keeps resetting the idle timer is still aborted here.
   * Default: the transport falls back to {@link timeoutMs}.
   */
  deadlineMs?: number;
}

/** The pluggable transport (default: a `node:http`/`node:https` client with a pinning DNS lookup). */
export type EgressTransport = (url: URL, req: EgressTransportRequest) => Promise<EgressTransportResponse>;

/** Options for {@link guardedFetch} (extends the guard options). */
export interface GuardedFetchOptions extends EgressGuardOptions {
  /** Max redirects to follow, each re-validated. Default: 5. */
  maxRedirects?: number;
  /** Per-socket IDLE timeout in ms applied by the default transport. Default: 30000. */
  timeoutMs?: number;
  /**
   * Overall TOTAL-time budget in ms per attempt (in addition to the idle {@link timeoutMs}). Bounds
   * the whole request lifetime so a trickle/slowloris cannot hold the socket open indefinitely.
   * Default (in the node transport): falls back to {@link timeoutMs}.
   */
  deadlineMs?: number;
  /** Transport override (tests / custom client). Default: the pinning node transport. */
  transport?: EgressTransport;
}
