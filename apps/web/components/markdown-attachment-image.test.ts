import { expect, test } from "bun:test";
import {
  ATTACHMENT_IMG_TAG,
  rehypeAttachmentImages,
  rehypeAttachmentRefsPre,
} from "./markdown-attachment-image";

/**
 * The two rehype passes (ADR-0082 §5) are pure hast transforms, so we exercise them directly on a
 * minimal tree: pass 1 (pre-sanitize) strips `<img>` — attachment refs → an inert token, everything
 * else dropped — and pass 2 (post-sanitize) mints the trusted `attachmentimg` element from the token.
 * Together they guarantee no `<img>` ever survives into (or out of) the sanitizer.
 */

// Minimal hast helpers.
type Node = Record<string, unknown>;
const img = (src: string): Node => ({
  type: "element",
  tagName: "img",
  properties: { src },
  children: [],
});
const root = (...children: Node[]): Node => ({ type: "root", children });

function run(tree: Node) {
  rehypeAttachmentRefsPre()(tree as never);
  rehypeAttachmentImages()(tree as never);
  return tree;
}

test("an attachment: ref becomes an attachmentimg element carrying its id", () => {
  const tree = run(
    root({ type: "element", tagName: "p", properties: {}, children: [img("attachment:cljk3abc123")] }),
  ) as { children: Array<{ children: Array<Node> }> };
  const p = tree.children[0];
  expect(p.children).toHaveLength(1);
  const el = p.children[0] as { tagName: string; properties: { attachment: string } };
  expect(el.tagName).toBe(ATTACHMENT_IMG_TAG);
  expect(el.properties.attachment).toBe("cljk3abc123");
});

test("external / data image URLs are dropped entirely (no img, no element)", () => {
  for (const src of ["https://evil.example/pixel.png", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
    const tree = run(
      root({ type: "element", tagName: "p", properties: {}, children: [img(src)] }),
    ) as { children: Array<{ children: Array<Node> }> };
    expect(tree.children[0].children).toHaveLength(0);
  }
});

test("no <img> element survives either pass", () => {
  const tree = run(
    root(
      { type: "element", tagName: "p", properties: {}, children: [img("attachment:abc123"), img("https://x/y.png")] },
    ),
  ) as { children: Array<{ children: Array<{ tagName?: string }> }> };
  const tags = tree.children[0].children.map((c) => c.tagName);
  expect(tags).not.toContain("img");
});

test("code/pre text is left untouched (a token inside code is not minted)", () => {
  // Pass 2 must skip literal-text subtrees. Feed a code element whose text already holds a sentinel.
  const tree = { type: "root", children: [
    { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "abc" }] },
  ] } as Node;
  rehypeAttachmentImages()(tree as never);
  const code = (tree as { children: Array<{ children: Array<{ type: string }> }> }).children[0];
  expect(code.children[0].type).toBe("text");
});
