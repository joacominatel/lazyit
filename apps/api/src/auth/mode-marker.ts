/**
 * Persisted auth-mode marker check (ADR-0086 §1). The auth mode (`shim` | `local` | `oidc`) is chosen
 * ONCE at first deploy and is IMMUTABLE: switching it on a populated instance half-migrates and bricks
 * (oidc users have `externalId` and no password; local users the reverse). Enforcement is not
 * documentation — the first successful `/setup` (F1c) persists the mode into the single-row
 * `instance_config` table, and every boot compares it against `env.AUTH_MODE`; a mismatch REFUSES to
 * start (fail-loud, same posture as boot-config).
 *
 * The DECISION is a pure function so it unit-tests without a database. The DB read (and the fail-loud
 * exit) is wired in main.ts AFTER NestFactory.create — the only place a Prisma client exists — but
 * BEFORE the server listens, so a mismatch never serves a request.
 *
 * F1a note: this phase only READS the marker (F1c writes it at first setup). Until then the marker is
 * always absent, so `decideModeMarker` always accepts — the check is inert until the write lands.
 */

export type AuthMode = 'shim' | 'local' | 'oidc';

export interface ModeMarkerDecision {
  /** true = the instance may boot; false = refuse (fail-loud with {@link ModeMarkerDecision.message}). */
  ok: boolean;
  /** CRITICAL log line to print before exiting, set only when `ok` is false. */
  message?: string;
}

/**
 * Decide whether the instance may boot given the persisted marker and the env AUTH_MODE.
 *
 *  - marker unset (`null`/`undefined`) → fresh install / not yet set up → ACCEPT `env.AUTH_MODE`.
 *  - marker set and equal to `env.AUTH_MODE` → ACCEPT.
 *  - marker set and DIFFERENT → REFUSE: someone flipped AUTH_MODE on a populated instance.
 *
 * @param storedMarker the `instance_config.authMode` value, or null/undefined when no row exists yet.
 * @param envAuthMode  the boot-validated `env.AUTH_MODE` (already one of shim|local|oidc by this point).
 */
export function decideModeMarker(
  storedMarker: string | null | undefined,
  envAuthMode: string | undefined,
): ModeMarkerDecision {
  if (storedMarker == null || storedMarker === '') {
    return { ok: true };
  }
  if (storedMarker === envAuthMode) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `AUTH_MODE=${envAuthMode ?? '(unset)'} does not match this instance's persisted auth mode ` +
      `"${storedMarker}". The auth mode is immutable (ADR-0086): set AUTH_MODE=${storedMarker} to boot, ` +
      `or migrate the instance's data out-of-band to change modes — a config flip half-migrates and bricks.`,
  };
}
