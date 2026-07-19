import { Injectable, Logger } from '@nestjs/common';
import { Client, Filter, type Entry } from 'ldapts';
import type { DirectoryTransport } from '@lazyit/shared';
import {
  DIRECTORY_ALWAYS_ATTRIBUTES,
  DIRECTORY_LDAP_CONNECT_TIMEOUT_MS,
  DIRECTORY_LDAP_MAX_ENTRIES,
  DIRECTORY_LDAP_PAGE_SIZE,
  DIRECTORY_LDAP_TIMEOUT_MS,
} from './directory.constants';

/**
 * The IN-MEMORY resolved directory config the reconcile hands the client for one run: the connection
 * fields plus the DECRYPTED bind password (never persisted, never logged). Assembled by the reconcile
 * from the singleton row + {@link decryptBindPassword}; the client never touches the DB or the crypto.
 */
export interface ResolvedDirectoryConfig {
  host: string;
  port: number;
  transport: DirectoryTransport;
  rejectUnauthorized: boolean;
  baseDN: string;
  bindDN: string | null;
  bindPassword: string | null;
  searchFilter: string;
  /** AD attribute NAMES to fetch (the values of the operator attribute map). objectGUID/memberOf are added. */
  attributeNames: string[];
}

/** One normalized directory entry: the canonical GUID natural key + flattened string attrs + group DNs. */
export interface DirectoryEntry {
  /** AD objectGUID formatted as a canonical GUID string — the immutable natural key. null if unreadable. */
  objectGUID: string | null;
  /** Single-valued string attributes, keyed by AD attribute name (first value when multi-valued). */
  attributes: Record<string, string>;
  /** The entry's `memberOf` group DNs, verbatim, stored INERT downstream (#846). */
  memberOf: string[];
}

/**
 * Format an AD `objectGUID` (a 16-byte binary attribute) into its canonical GUID string. AD stores the
 * GUID in mixed endianness: the first three groups are little-endian, the last two big-endian. Getting
 * this wrong yields an UNSTABLE natural key (duplicate persons every run), so it is unit-tested. Returns
 * null for a malformed buffer (wrong length) so the caller SKIPs rather than keys on garbage.
 */
export function formatObjectGuid(buf: Buffer): string | null {
  if (buf.length !== 16) return null;
  const h = (i: number): string => buf[i].toString(16).padStart(2, '0');
  return (
    h(3) +
    h(2) +
    h(1) +
    h(0) +
    '-' +
    h(5) +
    h(4) +
    '-' +
    h(7) +
    h(6) +
    '-' +
    h(8) +
    h(9) +
    '-' +
    h(10) +
    h(11) +
    h(12) +
    h(13) +
    h(14) +
    h(15)
  );
}

/**
 * Escape a value for safe interpolation into an RFC 4515 LDAP filter (delegates to ldapts `Filter.escape`).
 *
 * ponytail: the directory SYNC runs the operator's STATIC search filter verbatim over the subtree and keys
 * matches on objectGUID — it interpolates NO user/directory value into any filter, so the injection surface
 * is genuinely zero today. This helper is the SANCTIONED escaper any FUTURE per-value filter (e.g. a
 * single-user probe) MUST route through — never string-concatenate a value into a filter. Ceiling: if such
 * a path is added, escape every interpolated value here and cover it with the existing escaping test.
 */
export function escapeLdapFilterValue(value: string): string {
  return Filter.escape(value);
}

/** Map a raw ldapts attribute value (string | string[] | Buffer | Buffer[]) to its first string value. */
function firstString(value: Entry[string]): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) return undefined;
    return Buffer.isBuffer(first) ? first.toString('utf8') : first;
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
  return undefined;
}

/** Map a raw ldapts attribute value to a string ARRAY (for multi-valued memberOf). */
function stringArray(value: Entry[string] | undefined): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v));
}

/**
 * The read-only LDAP dialer (issue #839, ADR-0091). Binds read-only, PAGED subtree-searches the base DN
 * with the operator's static filter, and returns normalized {@link DirectoryEntry} rows. It NEVER writes to
 * the directory (no add/modify/delete), NEVER logs the bind password / DNs-with-secrets / attribute bodies,
 * and always `unbind()`s in a finally.
 *
 * TRANSPORT (security posture): `ldaps` = implicit TLS (`ldaps://`); `starttls` = plaintext connect then
 * `startTLS()`; `plaintext` = unencrypted `ldap://` (a loud opt-in). `rejectUnauthorized` defaults true
 * (verify the cert). NOT routed through the HTTP egress guard — AD legitimately lives on RFC1918 and the
 * guard's private-IP DENY would break every real deployment; the controls are the settings:manage gate,
 * the singleton config, and the bounded connect/op timeouts + paged/max-entries caps here.
 */
@Injectable()
export class DirectoryLdapClient {
  private readonly logger = new Logger(DirectoryLdapClient.name);

  /** Build the ldapts client URL + TLS options for the chosen transport. */
  private buildClient(config: ResolvedDirectoryConfig): Client {
    const scheme = config.transport === 'ldaps' ? 'ldaps' : 'ldap';
    const url = `${scheme}://${config.host}:${config.port}`;
    return new Client({
      url,
      timeout: DIRECTORY_LDAP_TIMEOUT_MS,
      connectTimeout: DIRECTORY_LDAP_CONNECT_TIMEOUT_MS,
      // TLS options apply to ldaps:// and to startTLS(). Under plaintext they are inert.
      tlsOptions: { rejectUnauthorized: config.rejectUnauthorized },
    });
  }

  /**
   * Bind read-only, subtree-search, and return the normalized entries. The whole exchange is bounded by the
   * op/connect timeouts and a paged search capped at {@link DIRECTORY_LDAP_MAX_ENTRIES}. Any failure throws
   * a SCRUBBED error (a short machine reason — ldapts errors can echo the DN/filter, so we never surface the
   * raw message to callers that log it).
   */
  async fetchEntries(
    config: ResolvedDirectoryConfig,
  ): Promise<DirectoryEntry[]> {
    const client = this.buildClient(config);
    try {
      if (config.transport === 'starttls') {
        await client.startTLS(
          config.rejectUnauthorized
            ? { rejectUnauthorized: true }
            : { rejectUnauthorized: false },
        );
      }
      // Read-only bind. A missing bindDN = anonymous bind (some read-only directories allow it).
      if (config.bindDN && config.bindPassword != null) {
        await client.bind(config.bindDN, config.bindPassword);
      } else {
        await client.bind('', '');
      }

      const attributes = Array.from(
        new Set([...config.attributeNames, ...DIRECTORY_ALWAYS_ATTRIBUTES]),
      );
      const { searchEntries } = await client.search(config.baseDN, {
        scope: 'sub',
        filter: config.searchFilter,
        attributes,
        // objectGUID is BINARY — force a Buffer so we can format it canonically (never string-coerce).
        explicitBufferAttributes: ['objectGUID'],
        sizeLimit: DIRECTORY_LDAP_MAX_ENTRIES,
        paged: { pageSize: DIRECTORY_LDAP_PAGE_SIZE },
      });

      return searchEntries
        .slice(0, DIRECTORY_LDAP_MAX_ENTRIES)
        .map((entry) => this.normalize(entry));
    } catch (err) {
      // Scrub: log a generic reason, re-throw a short non-secret message (the raw ldapts error can echo the
      // DN/filter). The reconcile turns this into the redacted lastSyncStatus='error'.
      this.logger.warn(
        `LDAP directory fetch failed (${err instanceof Error ? err.name : 'unknown error'}).`,
      );
      throw new Error(scrubLdapError(err));
    } finally {
      // Best-effort teardown — an unbind failure must not mask the real result/error.
      await client.unbind().catch(() => undefined);
    }
  }

  /** Normalize one ldapts Entry: format the GUID, flatten mapped attrs, collect memberOf. */
  private normalize(entry: Entry): DirectoryEntry {
    const guidRaw = entry.objectGUID;
    let objectGUID: string | null = null;
    if (Buffer.isBuffer(guidRaw)) {
      objectGUID = formatObjectGuid(guidRaw);
    } else if (Array.isArray(guidRaw) && Buffer.isBuffer(guidRaw[0])) {
      objectGUID = formatObjectGuid(guidRaw[0]);
    }

    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'dn' || key === 'objectGUID' || key === 'memberOf') continue;
      const s = firstString(value);
      if (s !== undefined) attributes[key] = s;
    }

    return {
      objectGUID,
      attributes,
      memberOf: stringArray(entry.memberOf),
    };
  }
}

/** Turn any LDAP error into a SHORT, non-secret reason string (never the DN/filter/password). */
export function scrubLdapError(err: unknown): string {
  if (err instanceof Error) {
    // ldapts throws named error classes (InvalidCredentialsError, ConnectionError, …). The NAME is safe
    // and useful; the message can embed the DN/filter, so we deliberately drop it.
    switch (err.name) {
      case 'InvalidCredentialsError':
        return 'bind failed: invalid credentials';
      case 'InsufficientAccessRightsError':
        return 'bind failed: insufficient access rights';
      case 'TimeoutError':
        return 'directory did not respond in time';
      case 'ConnectionError':
        return 'could not connect to the directory host';
      default:
        return `directory error (${err.name})`;
    }
  }
  return 'directory error';
}
