/**
 * nextListKey — a stable, unique-per-session id for React list keys (#1125).
 *
 * WHY NOT `crypto.randomUUID()`: it is a **secure-context-only** API (HTTPS or `localhost`).
 * A self-hosted lazyit reached over plain HTTP on a LAN IP — a first-class deployment shape
 * (ADR-0087) — exposes `window.crypto` but NOT `randomUUID`, so calling it throws
 * `TypeError: crypto.randomUUID is not a function`. Development never reproduces this because
 * `localhost` *is* a secure context, which is exactly how #946/#970 shipped the crash.
 *
 * React list keys only need to be unique among **siblings** and stable across renders — not
 * globally unique, not unguessable, not cryptographic. A monotonic counter satisfies that in
 * every context, on every browser, with no platform API at all.
 *
 * NOT for anything but presentation: these ids are per-tab and reset on reload, so they must
 * never be persisted, sent to the API, or used as a domain identifier.
 */
let counter = 0;

export function nextListKey(): string {
  // ponytail: a plain counter, not a UUID. Sibling-unique is all a React key needs; swap for
  // `useId()`-derived keys only if a list ever needs ids stable across a full remount.
  counter += 1;
  return `k${counter}`;
}
