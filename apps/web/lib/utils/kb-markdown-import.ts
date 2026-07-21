/**
 * Client-side drag-and-drop markdown import for the KB "New article" form (#1106). A dropped (or
 * picked) `.md` file's text fills the editor's content field — read in-browser via `File.text()`,
 * NEVER uploaded (distinct from the server-side `/articles/import` flow in `import-article-dialog`).
 *
 * These are the pure, framework-agnostic halves kept out of the React component so the trust-boundary
 * checks (file type + size at the drop edge) and the title derivation are unit-testable:
 *   - {@link validateMarkdownFile} — the guard: accepted extension/mime AND a byte cap.
 *   - {@link parseMarkdownImport} — content = the raw file text; title = a leading `# H1`
 *     (after stripping a leading YAML frontmatter block), else the filename without its extension.
 */

/** Byte cap for a dropped markdown file. A runbook is text — 1 MB is already enormous for one. */
export const MARKDOWN_IMPORT_MAX_BYTES = 1024 * 1024;

/** Accepted file extensions (lowercase, with the dot). Also drives the `<input accept>` attribute. */
export const MARKDOWN_IMPORT_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

/** `accept` attribute for the a11y file picker — the same extensions the drop guard enforces. */
export const MARKDOWN_IMPORT_ACCEPT = MARKDOWN_IMPORT_EXTENSIONS.join(",");

/**
 * Accepted MIME types. Browsers frequently report an EMPTY `type` for `.md`/`.markdown` (no OS
 * mapping), so the extension is the primary signal and the mime is an accept-also — never a reject.
 */
const MARKDOWN_IMPORT_MIMES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);

/** The shape the guard needs — a real `File` satisfies it; a plain object keeps the test dependency-free. */
type FileLike = { name: string; size: number; type: string };

export type MarkdownImportRejection = { ok: false; reason: "type" | "size" };
export type MarkdownImportValidation = { ok: true } | MarkdownImportRejection;

/** Lowercased final extension of a filename (with the dot), or "" if it has none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * The trust boundary. Reject anything that is not an accepted markdown/plain-text file (by extension
 * OR mime) with `type`, then reject an oversize file with `size`. Type is checked first so a wrong
 * file that also happens to be huge reports the more fundamental problem.
 */
export function validateMarkdownFile(file: FileLike): MarkdownImportValidation {
  const extOk = (MARKDOWN_IMPORT_EXTENSIONS as readonly string[]).includes(
    extensionOf(file.name),
  );
  const mimeOk = file.type !== "" && MARKDOWN_IMPORT_MIMES.has(file.type.toLowerCase());
  if (!extOk && !mimeOk) return { ok: false, reason: "type" };
  if (file.size > MARKDOWN_IMPORT_MAX_BYTES) return { ok: false, reason: "size" };
  return { ok: true };
}

/**
 * Strip a leading YAML frontmatter block (`---`…`---`) if — and only if — the text opens with one.
 * A leading BOM is tolerated. Used solely for title derivation; the imported CONTENT keeps its
 * frontmatter verbatim (we set the field to the raw file text).
 */
export function stripFrontmatter(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Must open with `---` on its own line (optional trailing spaces), then a newline.
  const opening = /^---[ \t]*\r?\n/.exec(withoutBom);
  if (!opening) return withoutBom;
  // The closing fence is a line that is exactly `---` (optional trailing spaces).
  const rest = withoutBom.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!closing) return withoutBom; // unterminated frontmatter → treat the whole text as body
  return rest.slice(closing.index + closing[0].length);
}

/** The first ATX `# H1` heading's text, or `null` if the (post-frontmatter) body has none. */
function firstH1(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    // Exactly one `#` then at least one space — `##` (H2) and `#Foo` (not a heading) don't match.
    const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) {
      const heading = match[1].trim();
      if (heading) return heading;
    }
  }
  return null;
}

/** Filename with its final extension removed and surrounding whitespace trimmed. */
export function filenameToTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base.trim();
}

export interface MarkdownImport {
  /** The raw file text — set verbatim as the editor content (frontmatter kept as-is). */
  content: string;
  /** Derived title candidate: leading `# H1` (post-frontmatter), else the filename stem. */
  title: string;
}

/**
 * Parse a read markdown file into an import payload. Content is the raw text; the title is derived
 * for the caller to apply ONLY when the title field is still empty (never overwrite typed input).
 */
export function parseMarkdownImport(text: string, filename: string): MarkdownImport {
  const heading = firstH1(stripFrontmatter(text));
  return { content: text, title: heading ?? filenameToTitle(filename) };
}
