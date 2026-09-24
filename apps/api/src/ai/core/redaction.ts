/**
 * Redaction of a tool input before it reaches the permanent `AiActionLog` (tools-and-execution.md §10,
 * security.md §6.7: "redacted canonical arguments"; the ledger never records a secret).
 *
 * The catalog excludes every surface whose purpose is a credential (INV-AI-14), so a sensitive field in
 * a tool input is the exception, not the rule. This is the defence in depth for the day a tool carries
 * one anyway: any object key whose name looks like a credential is replaced by {@link REDACTED}, at any
 * depth, and long strings are clipped so a pasted document cannot bloat an immutable row.
 */

export const REDACTED = '[redacted]';

/**
 * Key names treated as sensitive, matched case-insensitively against the whole key with separators
 * (`_`, `-`, `.`) removed: `password`, `newPassword`, `api_key`, `clientSecret`, `accessToken`,
 * `privateKey`, `authorization`, `otp`, …
 */
const SENSITIVE_KEY =
  /(passw(or)?d|passphrase|secret|token|apikey|privatekey|credential|authorization|cookie|session|^otp$|^totp$|^pin$|^cvv$|signature|ciphertext|^key$)/i;

/** A string longer than this is clipped in the ledger (the invocation row keeps the full input). */
export const REDACTION_MAX_STRING = 2_000;

/** Nesting beyond this depth is replaced by {@link REDACTED}: a ledger row is not a data dump. */
const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/[_.-]/g, ''));
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
    return value.length > REDACTION_MAX_STRING
      ? `${value.slice(0, REDACTION_MAX_STRING)}…`
      : value;
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
