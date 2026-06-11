import type { WorkflowStep } from "@lazyit/shared";
import { buildContextTokens, type ContextToken } from "./context-tokens";

/**
 * Pure, framework-agnostic helpers for the `{{ token }}` template strings the workflow builder edits
 * (issues #337 path token-assist, #338 body composer, #339 advanced JSON editor). They MIRROR the
 * server data-mapper grammar (`apps/api/src/workflow-engine/mapping/data-mapper.ts`,
 * `renderTemplate`) so a string composed in the UI renders identically server-side:
 *
 *  - a placeholder is `{{ path | filter | filter:'arg' }}` — `{{` + non-`}` body + `}}`;
 *  - the path is a dotted token (`grantee.email`, `steps.step-1.response`);
 *  - the closed filter set is `lower | upper | trim | default:'…'` (a no-op for any other name).
 *
 * This module does NOT execute templates and is logic-less by construction — it only PARSES and
 * VALIDATES the surface form so the builder can offer token-assist, highlight spans, and warn before
 * save. The authoritative render (and the security-critical encoding/allowlist) stays server-side.
 */

/** The same placeholder grammar the server mapper uses (`{{` + minimal-non-`}` body + `}}`). */
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** A dotted token path: a root word then `.segment` parts (letters, digits, `_`, `-`). */
const TOKEN_PATH = /^[\w-]+(?:\.[\w-]+)*$/;

/** The closed filter set the server mapper applies (any other name is a no-op there). */
export const TEMPLATE_FILTERS = ["upper", "lower", "trim", "default"] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

/** One parsed piece of a template string: a literal run, or a `{{ … }}` token reference. */
export type TemplateSegment =
  | { type: "literal"; text: string }
  | {
      /** A `{{ … }}` reference. `raw` is the inner expression verbatim (`path | filter`). */
      type: "token";
      raw: string;
      /** The dotted path (the part before the first `|`), trimmed. */
      path: string;
      /** The root of the path (the part before the first `.`), trimmed. */
      root: string;
    };

/** Split the inner `{{ … }}` expression into its path + filter list (path is part 0). */
function splitExpr(expr: string): { path: string; filters: string[] } {
  const parts = expr.split("|");
  return {
    path: (parts[0] ?? "").trim(),
    filters: parts.slice(1).map((f) => f.trim()),
  };
}

/**
 * Parse a template string into ordered literal + token segments. Mirrors the server's single-pass
 * placeholder scan, so what the UI highlights is exactly what the engine will interpolate. Text
 * outside a well-formed `{{ … }}` (including a dangling `{{` or `}}`) stays a literal segment.
 */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let lastIndex = 0;
  // The regex is stateful (global) — reset before each parse so repeated calls are independent.
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null = PLACEHOLDER.exec(template);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "literal",
        text: template.slice(lastIndex, match.index),
      });
    }
    const expr = match[1] ?? "";
    const { path } = splitExpr(expr);
    const root = path.split(".")[0]?.trim() ?? "";
    segments.push({ type: "token", raw: expr.trim(), path, root });
    lastIndex = match.index + match[0].length;
    match = PLACEHOLDER.exec(template);
  }
  if (lastIndex < template.length) {
    segments.push({ type: "literal", text: template.slice(lastIndex) });
  }
  return segments;
}

/** The result of validating a template's surface form against a known-roots allowlist. */
export interface TemplateValidation {
  /** Token roots that are not in the allowlist (would resolve empty at run time). */
  unknownRoots: string[];
  /** Token expressions whose path is structurally invalid (e.g. empty, or stray characters). */
  malformedPaths: string[];
  /** True when `{{` / `}}` counts don't balance (a placeholder was left open). */
  unbalanced: boolean;
  /** Filter names outside the closed set — they no-op server-side, surfaced as a soft warning. */
  unknownFilters: string[];
  /** Convenience: any hard problem (unknown root, malformed path, or unbalanced braces). */
  hasError: boolean;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    count += 1;
    from = haystack.indexOf(needle, from + needle.length);
  }
  return count;
}

/**
 * Validate a template's surface form: every token root is in `knownRoots`, every path is structurally
 * a dotted token, the `{{`/`}}` braces balance, and filters are in the closed set. Empty templates and
 * pure literals are always valid. This is advisory client-side feedback — the server is the real gate.
 */
export function validateTemplate(
  template: string,
  knownRoots: ReadonlySet<string>,
): TemplateValidation {
  const segments = parseTemplate(template);
  const unknownRoots = new Set<string>();
  const malformedPaths = new Set<string>();
  const unknownFilters = new Set<string>();

  for (const segment of segments) {
    if (segment.type !== "token") continue;
    const { path, filters } = splitExpr(segment.raw);
    if (path === "" || !TOKEN_PATH.test(path)) {
      malformedPaths.add(segment.raw);
    } else if (!knownRoots.has(segment.root)) {
      unknownRoots.add(segment.root);
    }
    for (const filter of filters) {
      const name = (filter.split(":")[0] ?? "").trim();
      if (name !== "" && !TEMPLATE_FILTERS.includes(name as TemplateFilter)) {
        unknownFilters.add(name);
      }
    }
  }

  // Unbalanced when the literal `{{` and `}}` counts differ (a placeholder was opened but not closed).
  const unbalanced =
    countOccurrences(template, "{{") !== countOccurrences(template, "}}");

  return {
    unknownRoots: [...unknownRoots],
    malformedPaths: [...malformedPaths],
    unknownFilters: [...unknownFilters],
    unbalanced,
    hasError: unbalanced || unknownRoots.size > 0 || malformedPaths.size > 0,
  };
}

/** The set of valid token roots offered for a step (the catalog's groups + actual `steps.<key>`). */
export function knownRootsFor(
  priorSteps: readonly WorkflowStep[] = [],
): Set<string> {
  // Every token path's first segment is a valid root (`event`, `grantee`, `application`, `grant`,
  // `steps`) — exactly the server mapper's ALLOWED_ROOTS. Deriving from the catalog keeps the
  // allowlist in lock-step with what the picker offers (the drift guard in template.test.ts pins it).
  const roots = new Set<string>();
  for (const token of buildContextTokens(priorSteps)) {
    const root = token.path.split(".")[0];
    if (root) roots.add(root);
  }
  return roots;
}

/** Wrap a dotted path into the `{{ … }}` placeholder the server renders (matches `tokenToTemplate`). */
export function wrapToken(path: string): string {
  return `{{ ${path} }}`;
}

/**
 * Insert `text` into `value` at `[selStart, selEnd)`, returning the new string and the caret offset
 * after the insertion. Used by the path field's "insert token" affordance so a token drops in at the
 * cursor (or replaces the selection) instead of always appending.
 */
export function insertAt(
  value: string,
  selStart: number,
  selEnd: number,
  text: string,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  const next = value.slice(0, start) + text + value.slice(end);
  return { value: next, caret: start + text.length };
}

/**
 * Serialise a data mapping (`Record<string,string>` of external field → template) into a pretty JSON
 * string for the advanced editor (#339). An empty/undefined mapping renders as `{}` so the editor is
 * never blank. The values stay verbatim template strings — JSON only quotes/escapes them.
 */
export function mappingToJson(
  mapping: Record<string, string> | undefined,
): string {
  return JSON.stringify(mapping ?? {}, null, 2);
}

/**
 * Parse the advanced editor's JSON back into a data mapping. Returns `{ mapping }` on a valid flat
 * string→string object, or `{ error }` (a short reason) otherwise — so the editor can keep the last
 * good value while surfacing the lint error. Only a flat object of string values is accepted (the
 * `WorkflowDataMapping` contract); nested/array/number values are rejected with a clear message.
 */
export function jsonToMapping(
  text: string,
):
  | { mapping: Record<string, string> | undefined; error?: undefined }
  | { mapping?: undefined; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { mapping: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Expected a JSON object of field → template" };
  }
  const mapping: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") {
      return { error: `Field "${key}" must be a string template` };
    }
    if (key.trim().length > 0) mapping[key] = val;
  }
  return { mapping: Object.keys(mapping).length > 0 ? mapping : undefined };
}

/** Group the catalog tokens by their i18n group for a sectioned picker (stable catalog order). */
export function groupTokens(
  tokens: readonly ContextToken[],
): Map<ContextToken["group"], ContextToken[]> {
  const groups = new Map<ContextToken["group"], ContextToken[]>();
  for (const token of tokens) {
    const list = groups.get(token.group);
    if (list) list.push(token);
    else groups.set(token.group, [token]);
  }
  return groups;
}
