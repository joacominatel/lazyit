import { BadRequestException } from '@nestjs/common';
import { WORKFLOW_REDACTED_VALUE, urlHasUserinfo } from '@lazyit/shared';

/**
 * Read-side redaction of a WorkflowConnection's plain config (SEC-075 / SEC-076).
 *
 * `defaultHeaders` is not validated against credential-like values, so an operator may have pasted a
 * token there; a legacy destination URL may carry `user:pass@`. Neither is a `secretId` reference, so
 * every read path (`GET /workflow-connections[/:id]`, the create/patch responses, the dry-run preview)
 * returns each header VALUE — and a URL's userinfo — as {@link WORKFLOW_REDACTED_VALUE}. Header NAMES
 * stay visible. The stored row is never changed: this is a projection, not a migration.
 */

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mask the userinfo of a URL string (`https://u:p@host` → `https://[redacted]@host`). */
export function redactUrlUserinfo(url: string): string {
  if (!urlHasUserinfo(url)) return url;
  return url.replace(
    /^(\s*[a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i,
    `$1${WORKFLOW_REDACTED_VALUE}@`,
  );
}

/** Every header value replaced by the sentinel (names kept). */
export function redactHeaderValues(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(headers).map((name) => [name, WORKFLOW_REDACTED_VALUE]),
  );
}

/** A copy of a stored connection config with header values and URL userinfo redacted. */
export function redactConnectionConfig(config: unknown): unknown {
  if (!isRecord(config)) return config;
  const out: Row = { ...config };
  if (isRecord(out.defaultHeaders)) {
    out.defaultHeaders = redactHeaderValues(
      out.defaultHeaders as Record<string, string>,
    );
  }
  for (const key of ['baseUrl', 'url'] as const) {
    if (typeof out[key] === 'string') {
      out[key] = redactUrlUserinfo(out[key]);
    }
  }
  return out;
}

/** Whether a stored config's destination URL carries userinfo (a pre-SEC-076 legacy row). */
export function configHasLegacyUserinfo(config: unknown): boolean {
  if (!isRecord(config)) return false;
  return (['baseUrl', 'url'] as const).some(
    (key) => typeof config[key] === 'string' && urlHasUserinfo(config[key]),
  );
}

/**
 * A connection row with its `config` redacted (every other column untouched), plus the additive
 * `legacyUserinfo` flag: `true` when the stored URL carries `user:pass@` (saved before SEC-076 refused
 * it on write). Such a row keeps working at run time (upgrade-safe); the flag lets the UI warn the
 * operator to move the credential into the secret store.
 */
export function redactConnection<T extends { config: unknown }>(
  row: T,
): T & { legacyUserinfo: boolean } {
  return {
    ...row,
    config: redactConnectionConfig(row.config),
    legacyUserinfo: configHasLegacyUserinfo(row.config),
  };
}

/**
 * Resolve the `defaultHeaders` of a PATCH against the stored ones: a value equal to the sentinel KEEPS
 * the stored value of that header (so a UI round-trip of a redacted read never overwrites it). A
 * sentinel for a header that is not stored has nothing to keep → 400.
 */
export function resolveRedactedHeaders(
  next: Record<string, string>,
  stored: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([name, value]) => {
      if (value !== WORKFLOW_REDACTED_VALUE) return [name, value];
      const kept =
        stored && Object.hasOwn(stored, name) ? stored[name] : undefined;
      if (typeof kept !== 'string') {
        throw new BadRequestException(
          `defaultHeaders.${name} is "${WORKFLOW_REDACTED_VALUE}" but the connection stores no such header — send its value`,
        );
      }
      return [name, kept];
    }),
  );
}

/** The stored REST `defaultHeaders` of a raw config (none for any other kind / shape). */
export function storedHeadersOf(
  config: unknown,
): Record<string, string> | undefined {
  if (!isRecord(config) || !isRecord(config.defaultHeaders)) return undefined;
  return config.defaultHeaders as Record<string, string>;
}
