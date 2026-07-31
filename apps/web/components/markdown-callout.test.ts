import { expect, test } from "bun:test";
import rehypeSlug from "rehype-slug";
import { CALLOUT_TAG, rehypeCallouts } from "./markdown-callout";
import {
  rehypeSecretChips,
  SECRET_CHIP_TAG,
} from "./markdown-secret-chip";

/**
 * The Phase-1 renderer passes (#1106) are pure hast transforms, so we exercise them directly on
 * minimal trees — mirroring `markdown-attachment-image.test.ts`. These cover the load-bearing
 * behaviours: read-tolerance (a plain blockquote is untouched), the callout transform, the
 * nested-context secret-chip regression (chips must still be minted MASKED inside a callout AND
 * inside a table cell after the callout pass runs), and stable/deduped heading ids.
 */

// Minimal hast helpers.
type Node = Record<string, unknown>;
const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, children: Node[], properties: Node = {}): Node => ({
  type: "element",
  tagName,
  properties,
  children,
});
const root = (...children: Node[]): Node => ({ type: "root", children });

/** Depth-first search for the first element with the given tagName. */
function find(node: Node, tagName: string): Node | null {
  if (node.type === "element" && node.tagName === tagName) return node;
  const children = node.children as Node[] | undefined;
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    const hit = find(child, tagName);
    if (hit) return hit;
  }
  return null;
}

/** Collect the concatenated text value under a node. */
function textOf(node: Node): string {
  if (node.type === "text") return node.value as string;
  const children = node.children as Node[] | undefined;
  if (!Array.isArray(children)) return "";
  return children.map(textOf).join("");
}

test("a [!WARNING] blockquote becomes a callout element and the marker is stripped", () => {
  const tree = root(
    el("blockquote", [
      text("\n"),
      el("p", [text("[!WARNING]\nDon't do this in production.")]),
      text("\n"),
    ]),
  );
  rehypeCallouts()(tree as never);

  const callout = find(tree, CALLOUT_TAG) as Node & { properties: Node };
  expect(callout).not.toBeNull();
  expect(callout.properties.variant).toBe("warning");
  // No <blockquote> survives; the marker text is gone, the body remains (inter-block whitespace
  // text nodes are preserved, so trim before comparing the body).
  expect(find(tree, "blockquote")).toBeNull();
  expect(textOf(callout)).not.toContain("[!WARNING]");
  expect(textOf(callout).trim()).toBe("Don't do this in production.");
});

test("a plain blockquote (no marker) is left untouched — read-tolerance", () => {
  const tree = root(
    el("blockquote", [el("p", [text("Just a regular quote, nothing special.")])]),
  );
  rehypeCallouts()(tree as never);

  expect(find(tree, "blockquote")).not.toBeNull();
  expect(find(tree, CALLOUT_TAG)).toBeNull();
});

test("a secret chip inside a callout blockquote is still minted (masked) after the callout pass", () => {
  const tree = root(
    el("blockquote", [
      el("p", [text("[!IMPORTANT]\nRotate {{ lazyit_secret.db_password }} monthly.")]),
    ]),
  );
  // Callouts run BEFORE secret chips in MarkdownView's post-sanitize slot — the chip must survive
  // the transform and get minted inside the callout, never leaked as plaintext.
  rehypeCallouts()(tree as never);
  rehypeSecretChips()(tree as never);

  const callout = find(tree, CALLOUT_TAG);
  expect(callout).not.toBeNull();
  const chip = find(callout as Node, SECRET_CHIP_TAG) as Node & {
    properties: Node;
  };
  expect(chip).not.toBeNull();
  expect(chip.properties.handle).toBe("db_password");
});

test("a secret chip inside a table cell is minted (masked) — nested-context", () => {
  const tree = root(
    el("table", [
      el("tbody", [
        el("tr", [el("td", [text("{{ lazyit_secret.api_key }} in prod")])]),
      ]),
    ]),
  );
  rehypeSecretChips()(tree as never);

  const chip = find(tree, SECRET_CHIP_TAG) as Node & { properties: Node };
  expect(chip).not.toBeNull();
  expect(chip.properties.handle).toBe("api_key");
});

test("rehype-slug stamps stable, deduped ids on headings", () => {
  const tree = root(
    el("h2", [text("Getting Started")]),
    el("h2", [text("Getting Started")]),
  );
  rehypeSlug()(tree as never);

  const headings = (tree.children as Node[]).map(
    (h) => (h.properties as { id?: string }).id,
  );
  expect(headings).toEqual(["getting-started", "getting-started-1"]);
});
