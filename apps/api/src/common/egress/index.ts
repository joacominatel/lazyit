/**
 * Egress guard — the central, reusable anti-SSRF control for outbound HTTP.
 *
 * Public surface:
 *   - {@link assertUrlAllowed} / {@link isUrlAllowed} — validate (and pin) a URL against the policy.
 *   - {@link guardedFetch} — a fetch-style wrapper that pins the dialed IP and re-validates redirects.
 *   - {@link classifyIp} + {@link AddressCategory} — the IP-range classifier (also independently useful).
 *   - {@link createNodeTransport} / {@link createPinnedLookup} — the pinning transport internals.
 *   - {@link EgressError} + types — the error / option / result contracts (incl. the allowlist seam).
 *
 * Phase 0 prerequisite: NOT wired into any route or service yet.
 */
export {
  assertUrlAllowed,
  isUrlAllowed,
  guardedFetch,
  createNodeTransport,
  createPinnedLookup,
  defaultDnsLookup,
} from './egress-guard';

export {
  classifyIp,
  isAllowlistableCategory,
  isPublicCategory,
  type AddressCategory,
} from './ip-rules';

export {
  EgressError,
  type DnsLookup,
  type EgressDenyReason,
  type EgressGuardOptions,
  type EgressTransport,
  type EgressTransportRequest,
  type EgressTransportResponse,
  type GuardedFetchOptions,
  type InternalTargetAllowlist,
  type InternalTargetContext,
  type ResolvedAddress,
  type ResolvedTarget,
} from './types';
