/**
 * Redaction of a tool input before it reaches the permanent `AiActionLog` (tools-and-execution.md §10,
 * security.md §6.7: "redacted canonical arguments"; the ledger never records a secret).
 *
 * The catalog excludes every surface whose purpose is a credential (INV-AI-14), so a sensitive field in
 * a tool input is the exception, not the rule. This is the defence in depth for the day a tool carries
 * one anyway: any object key whose name looks like a credential is replaced by {@link REDACTED}, at any
 * depth, credentials embedded in URLs (`scheme://user:pw@host`) are masked in every string, and long
 * strings are clipped so a pasted document cannot bloat an immutable row.
 */

export const REDACTED = '[redacted]';

/**
 * Sensitive key detection, two ways:
 *   - a SUBSTRING of the key with separators (`_`, `-`, `.`) removed and lower-cased — for fragments that
 *     are unambiguous anywhere in a name: `password`, `passwd`, `secret`, `token`, `credential`,
 *     `authorization`, `bearer`, `jwt`, `apikey`, `accesskey`, `privatekey`, `encryptionkey`,
 *     `licensekey`, `sshkey`, `recoverycode`, …;
 *   - a WHOLE WORD of the key split on camelCase and separators — for short fragments that would
 *     otherwise hit innocent names: `pass` (not `passenger`), `pwd`, `auth` (not `author`), `otp`, `pin`,
 *     `key` alone.
 */
const SENSITIVE_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'authorization',
  'bearer',
  'jwt',
  'apikey',
  'accesskey',
  'privatekey',
  'encryptionkey',
  'licensekey',
  'sshkey',
  'recoverycode',
  'cookie',
  'signature',
  'ciphertext',
];
const SENSITIVE_WORDS = new Set([
  'pass',
  'pwd',
  'auth',
  'otp',
  'totp',
  'pin',
  'cvv',
  'key',
  'session',
]);

/** `scheme://user:password@host` or `scheme://token@host` — the credential part of a URL. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** A string longer than this is clipped in the ledger (the invocation row keeps the full input). */
export const REDACTION_MAX_STRING = 2_000;

/** Nesting beyond this depth is replaced by {@link REDACTED}: a ledger row is not a data dump. */
const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  const flat = key.replace(/[\s_.-]/g, '').toLowerCase();
  if (SENSITIVE_FRAGMENTS.some((fragment) => flat.includes(fragment))) {
    return true;
  }
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .map((w) => w.toLowerCase());
  return words.some((w) => SENSITIVE_WORDS.has(w));
}

/** Replace the credentials embedded in any URL inside `text` with {@link REDACTED}. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}

/**
 * A JSON-safe, redacted copy of `value`. Never mutates the input. Non-JSON values (functions, symbols,
 * `undefined` inside objects) are dropped as `JSON.stringify` would drop them.
 */
export function redactInput(value: unknown): unknown {
  return redact(value, 0);
}

function redact(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    const clean = redactUrlCredentials(value);
    return clean.length > REDACTION_MAX_STRING
      ? `${clean.slice(0, REDACTION_MAX_STRING)}…`
      : clean;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const out = redact(item, depth + 1);
      return out === undefined ? null : out;
    });
  }
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    const redacted = redact(item, depth + 1);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}
