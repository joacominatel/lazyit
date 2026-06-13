import { slugify } from "@lazyit/shared";

/**
 * Render-time `[[slug]]` wiki-link support for `MarkdownView` (ADR-0059 §3). A tiny, dependency-free
 * rehype transform that runs in the SAME post-sanitize slot as the mermaid/code custom renderers
 * (ADR-0029): `rehype-sanitize` first strips all untrusted HTML, THEN this trusted pass turns
 * Obsidian-style `[[slug]]` tokens in text nodes into a custom `wikilink` element. `MarkdownView`
 * maps that element to a React `WikiLink` component, so the sanitizer never has to allow it and the
 * SEC-003 (stored XSS) guarantee is preserved by construction.
 *
 * Resolution (resolved → clickable link; unresolved → non-clickable tooltip "document not created
 * yet") is NOT decided here — that is the component's render-time concern, driven by the set of live
 * slugs. This pass only marks WHERE a link is and WHAT slug it targets.
 */

/** A minimal subset of the hast node shapes this transform touches (avoids a `@types/hast` dep). */
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
 * Match an Obsidian-style `[[ … ]]` token. The inner capture mirrors the shared `parseWikiLinks`
 * grammar (`[^\][]` forbids nested brackets, so `[[a]] [[b]]` is two tokens and an unterminated `[[`
 * never swallows the rest). The body may carry a `|display` alias and/or `#heading` anchor.
 */
const WIKI_LINK_TOKEN = /\[\[([^\][]+?)\]\]/g;

/** The element tagName the transform emits and `MarkdownView` maps to the `WikiLink` component. */
export const WIKI_LINK_TAG = "wikilink";

/**
 * Reduce a raw `[[ … ]]` body to `{ slug, label }`: `slug` is the resolution key (alias/anchor
 * stripped, then `slugify`d — exactly the shared `parseWikiLinks` reduction), `label` is the display
 * text the reader sees (the `|display` alias when present, else the verbatim target text). Returns
 * `null` for an empty/anchor-only token (e.g. `[[#section]]`) so the caller leaves the raw text be.
 */
function parseToken(body: string): { slug: string; label: string } | null {
  // `|display` is presentation; `#heading` is an in-page anchor — neither is part of the slug.
  const beforePipe = body.split("|")[0];
  const target = beforePipe.split("#")[0];
  const slug = slugify(target);
  if (slug === "") return null;
  const pipeIndex = body.indexOf("|");
  const label =
    pipeIndex >= 0 ? body.slice(pipeIndex + 1).trim() : target.trim();
  return { slug, label: label || target.trim() };
}

/**
 * Split a single text value into a mix of plain-text nodes and `wikilink` element nodes. Returns
 * `null` when the text has no `[[…]]` token (the common case), so the caller can skip replacing the
 * node entirely. The original `[[slug]]` substring is preserved on the element (`data-raw`) only for
 * debugging; rendering uses the `slug`/`label` properties.
 */
function splitText(value: string): HastNode[] | null {
  WIKI_LINK_TOKEN.lastIndex = 0;
  if (!WIKI_LINK_TOKEN.test(value)) return null;
  WIKI_LINK_TOKEN.lastIndex = 0;

  const out: HastNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_TOKEN.exec(value)) !== null) {
    const parsed = parseToken(match[1]);
    if (!parsed) continue; // anchor-only / empty token → leave the raw text in place
    if (match.index > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    out.push({
      type: "element",
      tagName: WIKI_LINK_TAG,
      properties: { slug: parsed.slug, label: parsed.label },
      children: [{ type: "text", value: parsed.label }],
    });
    lastIndex = match.index + match[0].length;
  }
  if (out.length === 0) return null; // only anchor-only tokens matched → nothing to replace
  if (lastIndex < value.length) {
    out.push({ type: "text", value: value.slice(lastIndex) });
  }
  return out;
}

/** True for a hast element we must NOT descend into — its text is verbatim source, not prose. */
function isLiteralElement(node: HastNode): boolean {
  if (node.type !== "element") return false;
  const tag = (node as HastElement).tagName;
  // Code / pre carry literal text (a `[[x]]` inside a code span is not a link). The `wikilink`
  // element we just produced is skipped so a re-run can't nest.
  return tag === "code" || tag === "pre" || tag === WIKI_LINK_TAG;
}

/**
 * The rehype plugin. Returns a transformer that walks the hast tree and, for every text node NOT
 * inside a code/pre/wikilink element, replaces `[[slug]]` tokens with `wikilink` elements. Appended
 * AFTER `rehype-sanitize` in `MarkdownView`, so it only ever sees already-sanitized content and adds
 * trusted link markup the sanitizer never has to allow.
 */
export function rehypeWikiLinks() {
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
