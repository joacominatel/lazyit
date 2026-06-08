import type { WorkflowDataMapping } from '@lazyit/shared';
import type { WorkflowMappingContext } from '../handlers/step-handler';

/**
 * The logic-less data mapper (ADR-0054 §7, `docs/workflow-engine/security.md` §7,
 * `docs/workflow-engine/integrations-connectors.md` §6).
 *
 * Turns lazyit context into an external payload via a SAFE template over a FROZEN, allowlisted `ctx`.
 * This is an SSTI→RCE + downstream-injection sink, so the design is logic-less BY CONSTRUCTION:
 *
 *  - **No code execution, ever.** `{{ path }}` interpolation only — no `eval` / `Function` / `vm`, no
 *    arbitrary helpers, no `{{#if}}` blocks. The ONLY logic is a CLOSED, non-extensible allowlist of
 *    pure string filters ({@link FILTERS}).
 *  - **Single pass.** Each `{{ … }}` is replaced with a literal resolved value; resolved values are
 *    NEVER re-scanned, so a value that itself contains `{{ … }}` cannot trigger nested templating.
 *  - **Frozen, allowlisted ctx.** A path may read ONLY from the allowlisted roots
 *    ({@link ALLOWED_ROOTS}); anything else resolves empty. Property access is own-enumerable only and
 *    a path segment of `__proto__` / `prototype` / `constructor` is rejected (prototype-pollution /
 *    SSTI guard).
 *  - **Context-aware output encoding.** Every interpolation is encoded for its destination
 *    ({@link EncodingMode}) by the mapper, not the admin: JSON body leaves rely on the caller's
 *    `JSON.stringify`; URL path/query segments are percent-encoded; header values are stripped of
 *    CR/LF + control chars; manual-prompt text is left as-is for in-app display.
 */

/** Where a rendered value is going, so the mapper can encode it correctly. */
export type EncodingMode =
  | 'json' // a JSON body leaf — identity; the caller's JSON.stringify escapes the assembled value.
  | 'url' // a URL path segment or query value — percent-encoded.
  | 'header' // an HTTP header value — CR/LF + control chars stripped (no header injection).
  | 'text'; // lazyit-internal display text (e.g. a MANUAL prompt) — identity; the web escapes on render.

/** The top-level ctx roots a template may read. Anything outside this allowlist resolves to empty. */
export const ALLOWED_ROOTS: ReadonlySet<string> = new Set([
  'event',
  'grantee',
  'application',
  'grant',
  'steps',
]);

/** Path segments that are NEVER traversable (prototype-pollution / SSTI guard). */
const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** CR/LF + all C0 control chars + DEL — stripped from header values (no header injection). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * The CLOSED, non-extensible set of pure string filters. Each takes the current value (string) plus an
 * optional single argument and returns a string. There is intentionally no way for an admin to add a
 * filter (that would be an arbitrary-code seam).
 */
const FILTERS: Readonly<
  Record<string, (value: string, arg?: string) => string>
> = Object.freeze({
  lower: (v) => v.toLowerCase(),
  upper: (v) => v.toUpperCase(),
  trim: (v) => v.trim(),
  // `default:fallback` — use the fallback when the resolved value is empty.
  default: (v, arg) => (v === '' ? (arg ?? '') : v),
});

/** A single `{{ … }}` placeholder: `{{` + minimal-non-`}` + `}}`. */
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** The result of mapping a {@link WorkflowDataMapping}. */
export interface MapResult {
  /** Target field name → rendered (encoded) string value. */
  values: Record<string, string>;
  /** The mapped field NAMES (keys) only — safe to record in redacted metadata (never the values). */
  fieldNames: string[];
}

/**
 * Resolve a dotted path against the frozen ctx, applying prototype-pollution + allowlist guards.
 * Returns the scalar string form, or `undefined` when the path is missing / blocked / non-scalar.
 */
function resolvePath(
  ctx: WorkflowMappingContext,
  path: string,
): string | undefined {
  const segments = path.split('.').map((s) => s.trim());
  if (segments.length === 0 || segments[0] === '') {
    return undefined;
  }
  // Allowlist the root; reject any blocked segment outright.
  if (!ALLOWED_ROOTS.has(segments[0])) {
    return undefined;
  }
  let current: unknown = ctx;
  for (const segment of segments) {
    if (segment === '' || BLOCKED_KEYS.has(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    // Own-enumerable access only — never walk up the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return scalarToString(current);
}

/** Coerce a resolved leaf to a string. Only scalars are interpolatable; objects/arrays → undefined. */
function scalarToString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  // Objects / arrays / functions are never interpolated (no accidental JSON dumps / [object Object]).
  return undefined;
}

/** Parse + apply the closed filter chain after the path (`path | filter | filter:arg`). */
function applyFilters(value: string, filterExprs: string[]): string {
  let out = value;
  for (const expr of filterExprs) {
    const colon = expr.indexOf(':');
    const name = (colon === -1 ? expr : expr.slice(0, colon)).trim();
    const rawArg = colon === -1 ? undefined : expr.slice(colon + 1).trim();
    const arg = rawArg === undefined ? undefined : unquote(rawArg);
    const filter = FILTERS[name];
    if (filter) {
      out = filter(out, arg);
    }
    // Unknown filter → no-op (logic-less: never an error path that could leak / inject).
  }
  return out;
}

/** Strip a single layer of matching single/double quotes from a filter argument. */
function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Encode a resolved value for its destination (the injection defense). */
function encode(value: string, mode: EncodingMode): string {
  switch (mode) {
    case 'url':
      return encodeURIComponent(value);
    case 'header':
      return value.replace(CONTROL_CHARS, '');
    case 'json':
    case 'text':
    default:
      return value;
  }
}

/**
 * Render ONE template string against the frozen ctx with per-placeholder, context-aware encoding.
 * Literal text outside `{{ … }}` passes through unchanged; a single pass guarantees a resolved value
 * is never re-interpreted as a template.
 */
export function renderTemplate(
  template: string,
  ctx: WorkflowMappingContext,
  mode: EncodingMode,
): string {
  return template.replace(PLACEHOLDER, (_match, expr: string) => {
    const parts = expr.split('|');
    const path = parts[0].trim();
    const filterExprs = parts.slice(1);
    const resolved = resolvePath(ctx, path);
    const withFilters = applyFilters(resolved ?? '', filterExprs);
    return encode(withFilters, mode);
  });
}

/**
 * Map a {@link WorkflowDataMapping} (target field → template) into rendered values. v1's mapping is a
 * flat string→string map (ADR-0054); each value is rendered with the given encoding `mode`. The
 * returned {@link MapResult.fieldNames} are safe to log; the values are NOT.
 *
 * For a JSON body, call with `mode: 'json'` then `JSON.stringify(result.values)` — the stringify
 * escapes every leaf, so an injected `"` / `{` in a ctx value can never break the payload.
 */
export function mapData(
  mapping: WorkflowDataMapping | undefined,
  ctx: WorkflowMappingContext,
  mode: EncodingMode,
): MapResult {
  const values: Record<string, string> = {};
  const fieldNames: string[] = [];
  if (!mapping) {
    return { values, fieldNames };
  }
  for (const [field, template] of Object.entries(mapping)) {
    // Guard the TARGET field name too — never let a mapping pollute the output object's prototype.
    if (BLOCKED_KEYS.has(field)) {
      continue;
    }
    values[field] = renderTemplate(template, ctx, mode);
    fieldNames.push(field);
  }
  return { values, fieldNames };
}
