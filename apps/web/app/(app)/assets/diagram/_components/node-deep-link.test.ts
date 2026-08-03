import { describe, expect, it } from "bun:test";
import { nodeToOpenFromUrl } from "./node-deep-link";

describe("nodeToOpenFromUrl", () => {
  // The bug this rule exists for (#1182): `?node=` was read ONCE, in a `useState` initializer. A
  // Table row click is a client-side navigation to the SAME route with different search params, so
  // `DiagramView` never remounts and the initializer never re-runs — the operator landed on the Map
  // with nothing selected and no detail open, while the comment on `diagramHref` claimed both. The
  // param has to be applied whenever it CHANGES, not only on mount.
  it("opens the node an in-app navigation names for the first time", () => {
    expect(nodeToOpenFromUrl(null, "node-a")).toBe("node-a");
  });

  it("follows the link when a later navigation names a different node", () => {
    expect(nodeToOpenFromUrl("node-a", "node-b")).toBe("node-b");
  });

  // The URL drives the landing; after that the operator owns the selection. Re-applying an
  // unchanged param would drag them back to the deep-linked node on every unrelated re-render (and
  // would re-open a detail they just closed).
  it("does not re-apply the node it has already applied", () => {
    expect(nodeToOpenFromUrl("node-a", "node-a")).toBeNull();
  });

  it("opens nothing when the URL names no node", () => {
    expect(nodeToOpenFromUrl("node-a", null)).toBeNull();
    expect(nodeToOpenFromUrl(null, null)).toBeNull();
  });

  // Dropping the param and coming back to the same node is a real navigation (Back, or a second
  // click on the same row after clearing the selection), so it must open again rather than be
  // swallowed as "already applied".
  it("re-opens a node the URL named, dropped, and named again", () => {
    expect(nodeToOpenFromUrl(null, "node-a")).toBe("node-a");
  });
});
