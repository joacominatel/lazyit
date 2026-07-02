import { attachmentRefId } from "@lazyit/shared";

/**
 * Render-time KB inline-image support for `MarkdownView` (ADR-0082 §5). Authors write
 * `![alt](attachment:<id>)`; this pair of tiny, dependency-free rehype transforms resolves that ref
 * to an authenticated same-origin `/api` image WITHOUT ever letting an `<img>` element pass through
 * the sanitizer — preserving the SEC-003 / [[0029]] guarantee by construction:
 *
 *   1. {@link rehypeAttachmentRefsPre} runs BEFORE `rehype-sanitize`. remark turns `![](…)` into a
 *      hast `<img>` element; this pass DELETES every such `<img>` — an attachment-ref one is replaced
 *      by an inert text SENTINEL token carrying its id; any other (external `https://`, `data:`,
 *      `javascript:` …) is dropped outright (ADR-0082 §5 "external image URLs restricted out"). So no
 *      `<img>` element is ever handed to the sanitizer, and `SANITIZE_SCHEMA` is never widened.
 *   2. {@link rehypeAttachmentImages} runs AFTER `rehype-sanitize`, in the SAME post-sanitize slot as
 *      wiki-links / secret chips. It scans (already-sanitized) text for the sentinel token and mints
 *      a trusted `attachmentimg` element the sanitizer never had to allow; `MarkdownView` maps that
 *      to the `AttachmentImage` React component, which fetches the bytes over the authenticated API.
 *
 * The id is validated by {@link attachmentRefId} (charset only) here; the CONTENT endpoint enforces
 * the real per-article authz (404, never 403) — so a hand-typed/forged sentinel can only ever point
 * at an image the reader may already see on that article, never leak anything.
 */

/** A minimal subset of the hast node shapes these transforms touch (avoids a `@types/hast` dep). */
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
 * Private-use-area sentinels wrapping an attachment id in a text node between the two passes. PUA
 * codepoints never appear in real prose and cannot be typed, so pass 1's output is unambiguous; even
 * a pasted/forged token is authz-safe (see the file header). `rehype-sanitize` passes text node
 * VALUES through untouched, so the token survives sanitization intact.
 */
const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

/** Match a minted `\uE000<id>\uE001` token; the id charset mirrors `attachmentRefId` (cuid). */
const ATTACHMENT_TOKEN = /\uE000([a-z0-9]+)\uE001/gi;

/** The element tagName the post pass emits and `MarkdownView` maps to the `AttachmentImage` component. */
export const ATTACHMENT_IMG_TAG = "attachmentimg";

/**
 * PASS 1 (pre-sanitize). Walk the hast tree and rewrite every `<img>` element (remark only ever
 * mints these from trusted `![](…)` Markdown — raw HTML is escaped text, `rehype-raw` is off): an
 * `attachment:<id>` src becomes an inert `\uE000<id>\uE001` text node; any other src is dropped. No
 * `<img>` survives into the sanitizer.
 */
export function rehypeAttachmentRefsPre() {
  return function transform(tree: HastNode): void {
    stripImages(tree);
  };
}

/** Depth-first walk replacing `<img>` children in place (attachment → token; other → removed). */
function stripImages(node: HastNode): void {
  const children = (node as HastElement).children;
  if (!Array.isArray(children)) return;

  const next: HastNode[] = [];
  for (const child of children) {
    if (child.type === "element" && (child as HastElement).tagName === "img") {
      const src = (child as HastElement).properties?.src;
      const id = typeof src === "string" ? attachmentRefId(src) : null;
      // Attachment ref → inert token the post pass will mint from; anything else is dropped.
      if (id) next.push({ type: "text", value: `${TOKEN_OPEN}${id}${TOKEN_CLOSE}` });
      continue;
    }
    stripImages(child);
    next.push(child);
  }
  (node as HastElement).children = next;
}

/** Split one text value into plain-text + `attachmentimg` element nodes, or `null` when no token. */
function splitText(value: string): HastNode[] | null {
  ATTACHMENT_TOKEN.lastIndex = 0;
  if (!ATTACHMENT_TOKEN.test(value)) return null;
  ATTACHMENT_TOKEN.lastIndex = 0;

  const out: HastNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTACHMENT_TOKEN.exec(value)) !== null) {
    const id = match[1];
    if (!id) continue;
    if (match.index > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    out.push({
      type: "element",
      tagName: ATTACHMENT_IMG_TAG,
      properties: { attachment: id },
      children: [],
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
  return tag === "code" || tag === "pre" || tag === ATTACHMENT_IMG_TAG;
}

/**
 * PASS 2 (post-sanitize). Walk the tree and, for every text node NOT inside a code/pre element,
 * replace `\uE000<id>\uE001` sentinels with `attachmentimg` elements. Appended AFTER `rehype-sanitize`
 * in `MarkdownView` (alongside wiki-links / secret chips), so it only ever sees sanitized content and
 * mints trusted markup the sanitizer never had to allow.
 */
export function rehypeAttachmentImages() {
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
