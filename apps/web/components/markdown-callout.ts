/**
 * Render-time GitHub-style callout / admonition support for `MarkdownView` (#1106 Phase 1). A tiny,
 * dependency-free rehype transform that runs in the SAME post-sanitize slot as the wiki-link / secret
 * chip / attachment passes (ADR-0029): `rehype-sanitize` first strips all untrusted HTML, THEN this
 * trusted pass rewrites a `blockquote` whose first line is a `[!TYPE]` marker into a custom `callout`
 * element carrying the variant. `MarkdownView` maps that element to a React `Callout` component, so
 * the sanitizer never has to allow it and the SEC-003 (stored XSS) guarantee is preserved by
 * construction.
 *
 * CONTENT-AGNOSTIC + SAFE for both surfaces — it only reshapes trusted, already-sanitized structure —
 * so it runs for the KB *and* the public Manual (it is NOT gated behind `disableKbExtensions`).
 *
 * READ-TOLERANT: a blockquote WITHOUT a leading `[!TYPE]` marker is left exactly as it was (a plain
 * `blockquote`), so existing content renders identically. The marker text (and its trailing newline)
 * is stripped from the body; everything after it is kept as the callout body — including nested
 * secret chips / wiki-links, which are minted by their own passes running AFTER this one.
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

/** The five GitHub alert types (case-insensitive on input, lowercased on the emitted element). */
export const CALLOUT_VARIANTS = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/** The element tagName the transform emits and `MarkdownView` maps to the `Callout` component. */
export const CALLOUT_TAG = "callout";

/**
 * Match a leading `[!TYPE]` marker at the very start of the blockquote's first paragraph, plus any
 * whitespace/newline that separates it from the body. GitHub requires the marker to open the
 * blockquote, so we only ever test the FIRST text node of the FIRST paragraph.
 */
const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\]\s*/i;

/** Return the blockquote's first ELEMENT child if it is a `<p>` (the only place a marker may sit). */
function firstParagraph(bq: HastElement): HastElement | null {
  for (const child of bq.children) {
    if (child.type === "element") {
      const el = child as HastElement;
      return el.tagName === "p" ? el : null;
    }
  }
  return null;
}

/**
 * Try to turn one `<blockquote>` into a `<callout>` in place. Returns `true` when it matched a marker
 * (and was transformed), `false` when it should stay a plain blockquote.
 */
function transformBlockquote(bq: HastElement): boolean {
  const p = firstParagraph(bq);
  if (!p || p.children.length === 0) return false;

  const first = p.children[0];
  if (first.type !== "text") return false;

  const match = CALLOUT_MARKER.exec((first as HastText).value);
  if (!match) return false;

  const variant = match[1].toLowerCase();
  // Strip the marker (and its trailing whitespace/newline) from the leading text node.
  (first as HastText).value = (first as HastText).value.slice(match[0].length);
  // If that text node is now empty, drop it — and if the whole paragraph was just the marker,
  // drop the empty paragraph so the callout doesn't open with a blank line.
  if ((first as HastText).value === "") {
    p.children.shift();
    if (p.children.length === 0) {
      bq.children = bq.children.filter((c) => c !== p);
    }
  }

  bq.tagName = CALLOUT_TAG;
  bq.properties = { ...(bq.properties ?? {}), variant };
  return true;
}

/**
 * The rehype plugin. Returns a transformer that walks the hast tree and rewrites every
 * marker-carrying `blockquote` into a `callout` element. Appended AFTER `rehype-sanitize` in
 * `MarkdownView`, so it only ever sees already-sanitized content and mints trusted markup the
 * sanitizer never has to allow.
 */
export function rehypeCallouts() {
  return function transform(tree: HastNode): void {
    visit(tree);
  };
}

/** Depth-first walk. Transforms blockquotes on the way down, then descends into every child. */
function visit(node: HastNode): void {
  const el = node as HastElement;
  if (el.type === "element" && el.tagName === "blockquote") {
    transformBlockquote(el);
  }
  const children = el.children;
  if (!Array.isArray(children)) return;
  for (const child of children) visit(child);
}
