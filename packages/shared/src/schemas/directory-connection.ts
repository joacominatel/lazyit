import { z } from "zod";

/**
 * On-prem AD/LDAP directory-source configuration — the single source of truth for `api` (config store +
 * validation + the reconcile job) and `web` (the Settings → Instance → Directory form) of a READ-ONLY
 * LDAP directory that UPSERTS login-less `directoryOnly` persons into lazyit (issue #839, ADR-0091).
 *
 * DIRECTION IS ONE-WAY (read only): lazyit binds read-only, subtree-searches, and creates/refreshes
 * `directoryOnly` VIEWER persons. It NEVER writes back to AD, is NOT a new AUTH_MODE, and is NOT
 * LDAP-bind login. Groups (`memberOf`) are captured INERT in `directoryAttrs` (store-now-act-later,
 * #846), never treated as a subject.
 *
 * INSTANCE CONFIGURATION, following the singleton SmtpSettings/AssetTagScheme precedent (ADR-0063/0079):
 * ONE admin-only row, gated by `settings:manage`, off by default, never a 404 (an unconfigured instance
 * reads an explicit DISABLED default).
 *
 * SECRET DISCIPLINE (mirrors the SMTP write-only-secret shape): the read-only BIND PASSWORD is a
 * SERVER-MANAGED machine credential — the server MUST decrypt it to bind (the explicit inverse of the
 * zero-knowledge Secret Manager, INV-10). It is encrypted at rest (AES-256-GCM under `DIRECTORY_SECRET_KEY`)
 * and is WRITE-ONLY on the wire: the read shape exposes only `bindPasswordSet` (configured yes/no), never
 * the ciphertext or the cleartext.
 */

/**
 * The transport-security mode. A small closed set (no free-form booleans on the wire) so `web` renders a
 * clear radio and `api` maps each mode to an ldapts connection unambiguously:
 *   - `ldaps`    — implicit TLS from the first byte (`ldaps://:636`). The secure DEFAULT.
 *   - `starttls` — plaintext connect then upgrade to TLS via StartTLS (`ldap://:389` + `startTLS()`).
 *   - `plaintext`— unencrypted LDAP (`ldap://:389`). A LOUD opt-in for a trusted internal segment only;
 *                  the bind credential travels in the clear, so `api` refuses to send a password over it
 *                  unless the operator explicitly chose this mode.
 */
export const DIRECTORY_TRANSPORT_MODES = ["ldaps", "starttls", "plaintext"] as const;
export const DirectoryTransportSchema = z.enum(DIRECTORY_TRANSPORT_MODES);
export type DirectoryTransport = z.infer<typeof DirectoryTransportSchema>;

/**
 * The RECOGNIZED profile keys of the attribute map. These four map an AD attribute name onto a real
 * `User` column; every OTHER key in the map lands its AD value INERT under `directoryAttrs` (Asset.specs
 * posture, ADR-0007 — no per-field validation in this MVP). The value is the AD attribute NAME to read
 * (e.g. `{ firstName: "givenName", lastName: "sn", email: "mail", username: "sAMAccountName" }`).
 */
export const DIRECTORY_PROFILE_ATTRIBUTE_KEYS = [
  "firstName",
  "lastName",
  "email",
  "username",
] as const;

/**
 * A light structural check that a string looks like a Distinguished Name (RFC 4514-ish): a non-empty
 * comma-separated list of `attr=value` RDNs. Deliberately lenient (MVP) — it rejects obvious garbage at
 * the `settings:manage` save boundary without re-implementing a full DN parser (the ldapts client does
 * the strict parse at bind/search time). PURE (no ldapts import — this file is framework-agnostic).
 */
function looksLikeDn(value: string): boolean {
  const parts = value.split(",");
  return parts.every((p) => /^\s*[A-Za-z][\w-]*=.+$/.test(p));
}

/**
 * A light well-formedness check for an RFC 4515 search filter: non-empty, wrapped in a single balanced
 * parenthesized expression. This is the STATIC population filter the subtree sync runs verbatim (there is
 * NO per-user value interpolation, so no LDAP-injection surface — see directory-ldap.client.ts). The
 * check bounds the operator-supplied, `settings:manage`-gated value; it is not a full grammar validator.
 */
function looksLikeLdapFilter(value: string): boolean {
  const v = value.trim();
  if (!v.startsWith("(") || !v.endsWith(")")) return false;
  let depth = 0;
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * The REDACTED read shape returned by `GET /directory/connection` — the write-only projection of the
 * settings row (never carries the bind password). When no row has ever been written the api returns an
 * explicit DISABLED default (enabled false, empty fields) — never a 404 — so the form always renders a
 * concrete shape (the SmtpSettings/AssetTagScheme convention).
 */
export const DirectoryConnectionSchema = z.object({
  /** Master switch. false (default) = the sweeper never runs and "Sync now" refuses (disabled). */
  enabled: z.boolean(),
  /** LDAP/AD host. Null until configured. */
  host: z.string().nullable(),
  /** LDAP/AD port (1–65535). Null until configured (typically 636 for ldaps, 389 for starttls/plaintext). */
  port: z.number().int().min(1).max(65535).nullable(),
  /** Transport-security mode. */
  transport: DirectoryTransportSchema,
  /**
   * TLS cert verification. Default true (secure): reject a directory whose certificate can't be verified.
   * An admin may set false to allow a self-signed cert on an internal server (opt-in insecurity). Inert
   * under `plaintext`.
   */
  rejectUnauthorized: z.boolean(),
  /** The subtree search base (e.g. `OU=People,DC=corp,DC=example,DC=com`). Null until configured. */
  baseDN: z.string().nullable(),
  /** The read-only service bind DN (identifies the credential; NOT itself a secret). Null until configured. */
  bindDN: z.string().nullable(),
  /** The RFC 4515 population filter run verbatim over the subtree (static; no interpolation). */
  searchFilter: z.string().nullable(),
  /** AD-attribute → profile/`directoryAttrs` key map (see DIRECTORY_PROFILE_ATTRIBUTE_KEYS). */
  attributeMap: z.record(z.string(), z.string()).nullable(),
  /** How many days a person may be MISSING from AD before it is soft-offboarded (0–365). */
  offboardGraceDays: z.number().int().min(0).max(365),
  /** Whether an encrypted bind password is stored (write-only: the value itself is NEVER returned). */
  bindPasswordSet: z.boolean(),
  /** Optional ServiceAccount whose id attributes the sync's UserHistory rows (ADR-0048). Null = system actor. */
  serviceAccountId: z.string().nullable(),
  /** When the last sync run finished. Null until the first run. */
  lastSyncAt: z.iso.datetime().nullable(),
  /** Outcome of the last run. Null until the first run. */
  lastSyncStatus: z.enum(["ok", "error", "never"]).nullable(),
  /** Cached counts of the last run (mirrors UpdateSettings caching). Null until the first run. */
  lastSyncCounts: z
    .object({
      created: z.number().int().min(0),
      updated: z.number().int().min(0),
      offboarded: z.number().int().min(0),
      skipped: z.number().int().min(0),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DirectoryConnection = z.infer<typeof DirectoryConnectionSchema>;

/**
 * The `PUT /directory/connection` write shape. Wholesale upsert of the config fields. The BIND PASSWORD
 * is write-only:
 *   - OMITTED (or empty string) → the stored password is LEFT UNCHANGED (so re-saving the read form —
 *     which never receives the password — does not wipe it).
 *   - a non-empty string → the new password is encrypted and stored (set/rotate).
 *
 * host/port/baseDN/bindDN/searchFilter are optional-nullable so a half-filled draft can be saved with
 * `enabled:false`; the reconcile refuses to run until host + port + baseDN + searchFilter are present.
 * baseDN/bindDN are validated as DN-shaped and searchFilter as a balanced filter at this trust boundary.
 */
export const UpdateDirectoryConnectionSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  transport: DirectoryTransportSchema,
  rejectUnauthorized: z.boolean(),
  baseDN: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine(looksLikeDn, { message: "baseDN must be a valid Distinguished Name (e.g. OU=People,DC=corp,DC=com)." })
    .nullish(),
  bindDN: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine(looksLikeDn, { message: "bindDN must be a valid Distinguished Name." })
    .nullish(),
  searchFilter: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(looksLikeLdapFilter, {
      message: "searchFilter must be a balanced parenthesized LDAP filter, e.g. (&(objectClass=user)(objectCategory=person)).",
    })
    .nullish(),
  attributeMap: z.record(z.string(), z.string()).nullish(),
  offboardGraceDays: z.number().int().min(0).max(365),
  /** Write-only: omitted/empty keeps the stored bind password; a non-empty value sets/rotates it. */
  bindPassword: z.string().max(1024).optional(),
  serviceAccountId: z.string().nullish(),
});
export type UpdateDirectoryConnection = z.infer<typeof UpdateDirectoryConnectionSchema>;

/** Per-run outcome counts (the `POST /directory/sync` response + the cached `lastSyncCounts`). */
export const DirectorySyncCountsSchema = z.object({
  /** New directory persons created into the PENDING (directoryOnly) review tray. */
  created: z.number().int().min(0),
  /** Existing persons whose mapped profile fields / `directoryAttrs` were refreshed. */
  updated: z.number().int().min(0),
  /** Persons soft-offboarded (isActive=false + directoryOffboardedAt) after the grace threshold. */
  offboarded: z.number().int().min(0),
  /** Entries skipped (no usable objectGUID, an email collision with a login user, unchanged, etc.). */
  skipped: z.number().int().min(0),
});
export type DirectorySyncCounts = z.infer<typeof DirectorySyncCountsSchema>;

/**
 * `POST /directory/sync` response — the "Sync now" ad-hoc reconcile outcome (also cached on the row). On
 * failure `error` is a SHORT, non-secret message (e.g. "bind failed", "host unreachable"); it NEVER
 * carries the bind password, full DNs, or attribute PII.
 */
export const DirectorySyncResultSchema = z.object({
  ok: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  counts: DirectorySyncCountsSchema,
  error: z.string().nullable(),
});
export type DirectorySyncResult = z.infer<typeof DirectorySyncResultSchema>;
