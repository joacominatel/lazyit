/**
 * Wiring constants for the on-prem AD/LDAP directory-source subsystem (issue #839, ADR-0091). Pure data —
 * no DI — so the config store, the ldapts client, the reconcile service, the sweeper and the controller
 * share one set of literals without a module cycle.
 */

/** The fixed singleton primary key of the DirectoryConnection row (mirrors SmtpSettings, ADR-0063/0079). */
export const DIRECTORY_CONNECTION_SINGLETON_ID = 'singleton';

/**
 * The env var the 32-byte AES-256-GCM master key for the bind password is read from — its OWN key axis,
 * SEPARATE from `WORKFLOW_SECRET_KEY` / `SMTP_SECRET_KEY` ("one key per subsystem", ADR-0054/0079). Like
 * the SMTP key (NOT the fail-loud-at-boot workflow key), this is OPTIONAL: the app boots without it and
 * directory sync is simply unavailable; it is required only when an admin actually SAVES a bind password.
 */
export const DIRECTORY_SECRET_KEY_ENV = 'DIRECTORY_SECRET_KEY';

/** The `directorySource` discriminator stamped on an AD-reconciled person (vs an import-sourced one). */
export const DIRECTORY_SOURCE_AD = 'ad';

/** How often the sweeper runs the reconcile. Directory drift is slow — hourly is ample for a small team. */
export const DIRECTORY_SYNC_INTERVAL_MS_DEFAULT = 60 * 60 * 1000; // 1 hour

/** Bounded LDAP operation timeout (ms) — caps a hostile/slow directory from stalling the reconcile. */
export const DIRECTORY_LDAP_TIMEOUT_MS = 30_000;
/** Bounded TCP connect timeout (ms). */
export const DIRECTORY_LDAP_CONNECT_TIMEOUT_MS = 10_000;
/** Max entries pulled per page + hard cap on total entries — bounds a huge/hostile OU (worker DoS). */
export const DIRECTORY_LDAP_PAGE_SIZE = 100;
export const DIRECTORY_LDAP_MAX_ENTRIES = 50_000;

/** The AD attributes ALWAYS requested regardless of the operator attribute map (natural key + groups). */
export const DIRECTORY_ALWAYS_ATTRIBUTES = ['objectGUID', 'memberOf'] as const;

/** Read a positive-integer ms env var, falling back to `fallback` when unset/blank/non-numeric. */
export function directoryEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
