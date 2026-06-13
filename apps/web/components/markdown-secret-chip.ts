/**
 * Render-time `{{ lazyit_secret.HANDLE }}` chip support for `MarkdownView` (ADR-0061 §8). A tiny,
 * dependency-free rehype transform that runs in the SAME post-sanitize slot as `rehypeWikiLinks`
 * (ADR-0029): `rehype-sanitize` first strips all untrusted HTML, THEN this trusted pass turns
 * `{{ lazyit_secret.HANDLE }}` tokens in text nodes into a custom `secretchip` element.
 * `MarkdownView` maps that element to a React `SecretChip` component, so the sanitizer never has to
 * allow it and the SEC-003 (stored XSS) guarantee is preserved by construction.
 *
 * The token is inert text stored verbatim in Markdown — the HANDLE is the only information
 * embedded. No value is ever embedded or inferred client-side outside the component's reveal flow.
 */

/** A minimal subset of the hast node shapes this transform touches. */
interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element" | "root";
  tagName?: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/**
 * Match a `{{ lazyit_secret.HANDLE }}` token. The HANDLE capture allows letters, digits,
 * underscores, dots and hyphens — mirroring the backend handle charset (lowercase enforced at
 * creation, but we allow uppercase here so the regex is robust to hand-typed chips). Surrounding
 * spaces inside the braces are allowed and trimmed.
 */
const SECRET_CHIP_TOKEN =
  /\{\{\s*lazyit_secret\.([A-Za-z0-9_.-]+)\s*\}\}/g;

/** The element tagName the transform emits and `MarkdownView` maps to the `SecretChip` component. */
export const SECRET_CHIP_TAG = "secretchip";

/**
 * Split a single text value into a mix of plain-text nodes and `secretchip` element nodes. Returns
 * `null` when the text has no `{{ lazyit_secret.* }}` token (the common case), so the caller can
 * skip replacing the node entirely.
 */
function splitText(value: string): HastNode[] | null {
  SECRET_CHIP_TOKEN.lastIndex = 0;
  if (!SECRET_CHIP_TOKEN.test(value)) return null;
  SECRET_CHIP_TOKEN.lastIndex = 0;

  const out: HastNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_CHIP_TOKEN.exec(value)) !== null) {
    const handle = match[1];
    if (!handle) continue;
    if (match.index > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    out.push({
      type: "element",
      tagName: SECRET_CHIP_TAG,
      properties: { handle },
      children: [{ type: "text", value: match[0] }],
    });
    lastIndex = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (lastIndex < value.length) {
    out.push({ type: "text", value: value.slice(lastIndex) });
  }
  return out;
}

/** True for a hast element we must NOT descend into — its text is verbatim source, not prose. */
function isLiteralElement(node: HastNode): boolean {
  if (node.type !== "element") return false;
  const tag = (node as HastElement).tagName;
  // Code / pre carry literal text. The `secretchip` element we just produced is skipped so a
  // re-run can't nest. `wikilink` is skipped for completeness (no chips inside wiki-links).
  return tag === "code" || tag === "pre" || tag === SECRET_CHIP_TAG || tag === "wikilink";
}

/**
 * The rehype plugin. Returns a transformer that walks the hast tree and, for every text node NOT
 * inside a code/pre/secretchip element, replaces `{{ lazyit_secret.HANDLE }}` tokens with
 * `secretchip` elements. Appended AFTER `rehype-sanitize` in `MarkdownView` (alongside
 * `rehypeWikiLinks`), so it only ever sees already-sanitized content.
 */
export function rehypeSecretChips() {
  return function transform(tree: HastNode): void {
    visit(tree);
  };
}

/** Depth-first walk that rewrites text children in place, skipping literal-text subtrees. */
function visit(node: HastNode): void {
  const children = (node as HastElement).children;
  if (!Array.isArray(children)) return;

  const next: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text") {
      const replaced = splitText((child as HastText).value);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
      next.push(child);
    } else {
      if (!isLiteralElement(child)) visit(child);
      next.push(child);
    }
  }
  (node as HastElement).children = next;
}
