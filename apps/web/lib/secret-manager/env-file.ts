/**
 * `.env`-style parse / serialize for the Secret Manager export (#612) and import (#613).
 *
 * PURE, framework-agnostic, dependency-free (a few lines beat a parser dependency — ponytail).
 * These helpers ONLY move non-secret KEY names and (for import) plaintext values that already live
 * in the user's browser — they NEVER touch the server. The zero-knowledge line (INV-10) is upheld
 * by the CALLERS: import encrypts each parsed value with the in-memory DEK before it is sent, and
 * export serializes values the browser already decrypted locally and hands them to a download — the
 * server only ever receives the metadata-only audit body. Nothing here talks to the network.
 *
 * `.env` syntax handled (the common, useful subset):
 *   - `KEY=value` and `export KEY=value` (the `export ` prefix is stripped)
 *   - single- or double-quoted values (`KEY="a b"`, `KEY='a b'`) — quotes are removed; `\n`/`\t`/`\"`
 *     escapes inside DOUBLE quotes are unescaped (single quotes are literal, shell-style)
 *   - `# comment` lines and blank lines are ignored; trailing inline comments after an UNQUOTED
 *     value are stripped
 *   - keys must match `[A-Za-z_][A-Za-z0-9_]*` — anything else is reported as a malformed line
 */

/** One parsed `KEY=value` pair from a `.env` blob (value is plaintext, browser-only). */
export interface EnvEntry {
  key: string;
  value: string;
}

/** The outcome of parsing a `.env` blob: the valid pairs plus any malformed lines (for the preview). */
export interface ParsedEnv {
  entries: EnvEntry[];
  /** Lines that looked like content but could not be parsed (1-based line number + the raw text). */
  malformed: { line: number; raw: string }[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Unescape the common backslash escapes inside a double-quoted value (`\n`, `\r`, `\t`, `\"`, `\\`). */
function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c; // \" -> "  and  \\ -> \
    }
  });
}

/** Strip a trailing inline `# comment` from an UNQUOTED value (a `#` preceded by whitespace, or at start). */
function stripInlineComment(s: string): string {
  const idx = s.search(/(^|\s)#/);
  return idx === -1 ? s : s.slice(0, idx);
}

/** Parse a value token (right of the first `=`), handling quotes and inline comments. */
function parseValue(rawValue: string): string {
  const v = rawValue.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return unescapeDoubleQuoted(v.slice(1, -1));
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1);
  }
  return stripInlineComment(v).trim();
}

/**
 * Parse a `.env`-style blob into entries + malformed lines. Last-wins on duplicate keys WITHIN the
 * blob (mirrors how a shell sources a `.env`); the caller decides collisions against the vault.
 */
export function parseEnv(text: string): ParsedEnv {
  const entries: EnvEntry[] = [];
  const malformed: { line: number; raw: string }[] = [];
  const seen = new Map<string, number>(); // key -> index in `entries` (for last-wins dedupe)

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;

    const eq = withoutExport.indexOf("=");
    if (eq === -1) {
      malformed.push({ line: i + 1, raw });
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      malformed.push({ line: i + 1, raw });
      continue;
    }
    const value = parseValue(withoutExport.slice(eq + 1));

    const existing = seen.get(key);
    if (existing !== undefined) {
      entries[existing] = { key, value }; // last wins within the blob
    } else {
      seen.set(key, entries.length);
      entries.push({ key, value });
    }
  }

  return { entries, malformed };
}

/**
 * Split parsed entries into those whose key is NEW to the vault and those that already exist
 * (skip-existing collision policy, #613). `existingKeys` is compared case-SENSITIVELY against the
 * entry key — handles are lowercased elsewhere, so the caller passes the existing handles as-is.
 */
export function splitNewVsExisting(
  entries: EnvEntry[],
  existingKeys: Iterable<string>,
): { toCreate: EnvEntry[]; skipped: EnvEntry[] } {
  const existing = new Set(existingKeys);
  const toCreate: EnvEntry[] = [];
  const skipped: EnvEntry[] = [];
  for (const entry of entries) {
    if (existing.has(entry.key)) skipped.push(entry);
    else toCreate.push(entry);
  }
  return { toCreate, skipped };
}

/** Quote a value for `.env` serialization if it needs it (whitespace, `#`, `=`, quotes, or newlines). */
function serializeValue(value: string): string {
  if (value === "") return "";
  if (/[\s#="'\\]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Serialize entries back to a `.env` text blob (export, #612). Round-trips with {@link parseEnv}:
 * `parseEnv(serializeEnv(entries)).entries` yields the same key/value pairs.
 */
export function serializeEnv(entries: EnvEntry[]): string {
  return entries.map((e) => `${e.key}=${serializeValue(e.value)}`).join("\n");
}
