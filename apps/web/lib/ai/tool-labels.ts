/**
 * Localized names for tools and approval-card fields (issue #1377). The catalogs live in the `ai`
 * messages — `ai.toolNames.<tool_name>` and `ai.fields.<fieldKey>` — keyed by exactly what the API sends,
 * with two templated families for field paths that carry a user-defined name:
 *
 * - `input.<name>` — a workflow task's input field → `ai.fieldPrefixes.input` ("Input: {name}")
 * - `specs.<key>`  — an asset attribute            → `ai.fieldPrefixes.specs` ("Attribute: {name}")
 *
 * The name after the prefix is data (an operator named it) and is shown as it is. A tool or field this
 * build has no entry for falls back to the humanized key (`asset_search` → "Asset search"), so a newer
 * API never breaks the chat. A covering-set test keeps the catalogs in step with the API's tool registry.
 */

/** Tool names are lower-case snake case (`AI_TOOL_NAME_PATTERN` in `@lazyit/shared`). */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** A plain field key usable as a message key (no dots, which next-intl reads as nesting). */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

export const FIELD_PREFIXES = ["input", "specs"] as const;
export type FieldPrefix = (typeof FIELD_PREFIXES)[number];

/** The message key under `ai.toolNames` for a tool, or null when the name cannot be a key. */
export function toolNameKey(name: string): string | null {
  return TOOL_NAME.test(name) ? name : null;
}

export type FieldLabelRef =
  | { kind: "key"; key: string }
  | { kind: "prefixed"; prefix: FieldPrefix; name: string }
  | { kind: "none" };

/** How a preview field path is labelled: a catalog key, a templated prefix, or nothing (humanize). */
export function fieldLabelRef(field: string): FieldLabelRef {
  const dot = field.indexOf(".");
  if (dot > 0) {
    const prefix = field.slice(0, dot);
    const name = field.slice(dot + 1);
    if ((FIELD_PREFIXES as readonly string[]).includes(prefix) && name.trim() !== "") {
      return { kind: "prefixed", prefix: prefix as FieldPrefix, name };
    }
    return { kind: "none" };
  }
  return FIELD_KEY.test(field) ? { kind: "key", key: field } : { kind: "none" };
}
