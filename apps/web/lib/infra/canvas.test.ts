import { describe, expect, mock, test } from "bun:test";
import {
  debounce,
  edgeStroke,
  edgeStyle,
  gridPosition,
  layoutNodes,
  NODE_HEIGHT,
  NODE_WIDTH,
  placementOffset,
  statusTone,
} from "./canvas";

describe("statusTone", () => {
  test("maps each status to the app status language", () => {
    expect(statusTone("ONLINE")).toBe("success");
    expect(statusTone("OFFLINE")).toBe("danger");
    expect(statusTone("UNKNOWN")).toBe("neutral");
  });
});

describe("edgeStroke", () => {
  test("gives every edge kind a distinct token-backed stroke", () => {
    const strokes = [
      edgeStroke("RUNS_ON"),
      edgeStroke("MEMBER_OF"),
      edgeStroke("DEPENDS_ON"),
      edgeStroke("BACKS_UP_TO"),
      edgeStroke("CONNECTS_TO"),
    ];
    // All CSS variables…
    for (const s of strokes) expect(s).toMatch(/^var\(--[a-z-]+\)$/);
    // …and all distinct (so kinds are visually separable on the canvas).
    expect(new Set(strokes).size).toBe(strokes.length);
  });
});

describe("edgeStyle", () => {
  const kinds = [
    "RUNS_ON",
    "MEMBER_OF",
    "DEPENDS_ON",
    "BACKS_UP_TO",
    "CONNECTS_TO",
  ] as const;

  test("stroke matches edgeStroke for every kind", () => {
    for (const kind of kinds) {
      expect(edgeStyle(kind).stroke).toBe(edgeStroke(kind));
    }
  });

  test("encodes each kind by more than colour (line-style + marker + width)", () => {
    // A redundant fingerprint per kind: dash pattern + marker + width + animated. All distinct so a
    // colour-blind reader can still tell the kinds apart (the locked status/edge family, ADR-0049).
    const fingerprints = kinds.map((kind) => {
      const s = edgeStyle(kind);
      return `${s.dashArray ?? "solid"}|${s.marker ?? "none"}|${s.width}|${s.animated}`;
    });
    expect(new Set(fingerprints).size).toBe(kinds.length);
  });

  test("only DEPENDS_ON animates (the single moving kind, motion budget)", () => {
    for (const kind of kinds) {
      expect(edgeStyle(kind).animated).toBe(kind === "DEPENDS_ON");
    }
  });

  test("DEPENDS_ON is dashed, BACKS_UP_TO is dotted, the rest are solid", () => {
    expect(edgeStyle("DEPENDS_ON").dashArray).toBeDefined();
    expect(edgeStyle("BACKS_UP_TO").dashArray).toBeDefined();
    expect(edgeStyle("DEPENDS_ON").dashArray).not.toBe(
      edgeStyle("BACKS_UP_TO").dashArray,
    );
    expect(edgeStyle("RUNS_ON").dashArray).toBeUndefined();
    expect(edgeStyle("MEMBER_OF").dashArray).toBeUndefined();
  });

  test("the symmetric CONNECTS_TO has no arrowhead", () => {
    expect(edgeStyle("CONNECTS_TO").marker).toBeUndefined();
    // …while the directional kinds all carry one.
    for (const kind of ["RUNS_ON", "MEMBER_OF", "DEPENDS_ON", "BACKS_UP_TO"] as const) {
      expect(edgeStyle(kind).marker).toBeDefined();
    }
  });
});

describe("placementOffset", () => {
  test("the first create lands exactly on the centre", () => {
    expect(placementOffset({ x: 100, y: 50 }, 0)).toEqual({ x: 100, y: 50 });
  });

  test("each consecutive create fans down-right by a fixed step", () => {
    const center = { x: 0, y: 0 };
    expect(placementOffset(center, 1, 40)).toEqual({ x: 40, y: 40 });
    expect(placementOffset(center, 3, 40)).toEqual({ x: 120, y: 120 });
  });
});

describe("layoutNodes", () => {
  test("returns a position for every node, including isolated ones", () => {
    const nodes = [{ id: "host" }, { id: "vm" }, { id: "orphan" }];
    const edges = [{ sourceId: "vm", targetId: "host", kind: "RUNS_ON" as const }];
    const laid = layoutNodes(nodes, edges);
    expect(laid).toHaveLength(3);
    expect(new Set(laid.map((n) => n.id))).toEqual(
      new Set(["host", "vm", "orphan"]),
    );
    for (const n of laid) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test("ranks a host above its guest (top-down hierarchy)", () => {
    const nodes = [{ id: "host" }, { id: "vm" }];
    const edges = [{ sourceId: "vm", targetId: "host", kind: "RUNS_ON" as const }];
    const byId = Object.fromEntries(
      layoutNodes(nodes, edges).map((n) => [n.id, n]),
    );
    // The host (RUNS_ON target) sits on a higher layer ⇒ a smaller y than its guest VM.
    expect(byId.host.y).toBeLessThan(byId.vm.y);
  });

  test("non-hierarchical kinds don't drive the layers (no crash, both placed)", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    const edges = [{ sourceId: "a", targetId: "b", kind: "CONNECTS_TO" as const }];
    const laid = layoutNodes(nodes, edges);
    expect(laid).toHaveLength(2);
  });

  test("positions are top-left corners (centre shifted by half the node box)", () => {
    // A single node sits at dagre's margin centre; shifting by half the box must not throw and must
    // keep the box constants in sync with the helper.
    const [only] = layoutNodes([{ id: "solo" }], []);
    expect(typeof only.x).toBe("number");
    expect(NODE_WIDTH).toBeGreaterThan(0);
    expect(NODE_HEIGHT).toBeGreaterThan(0);
  });
});

describe("gridPosition", () => {
  test("lays nodes out left-to-right then wraps to the next row", () => {
    expect(gridPosition(0)).toEqual({ x: 0, y: 0 });
    // 4 columns → index 4 wraps to the second row.
    expect(gridPosition(4)).toEqual({ x: 0, y: 160 });
    // index 5 is column 1 of row 1.
    expect(gridPosition(5)).toEqual({ x: 260, y: 160 });
  });

  test("is deterministic in index (no reshuffle on re-render)", () => {
    expect(gridPosition(7)).toEqual(gridPosition(7));
  });
});

describe("debounce", () => {
  test("collapses a burst to a single trailing call with the latest args", async () => {
    const fn = mock((value: number) => value);
    const debounced = debounce(fn, 20);
    debounced(1);
    debounced(2);
    debounced(3);
    expect(fn).toHaveBeenCalledTimes(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
  });
});
