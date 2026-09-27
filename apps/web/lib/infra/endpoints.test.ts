/**
 * The rules that decide what an operator sees on the topology canvas (ADR-0093 §5, amended
 * 2026-09-09), pulled out of the component so they can be asserted rather than described.
 *
 * The failure this suite exists to prevent is not a cosmetic one: a host that drops off the map and
 * cannot be brought back is indistinguishable, to the operator looking at it, from data loss. So
 * every direction is pinned here —
 *
 *  1. **Nothing is hidden by default.** The CEO inverted the original hidden-by-default treatment:
 *     a first visit draws the whole estate, and hiding the workstations is what the operator opts
 *     into. `showEndpointsFromParam(null) === true` is the assertion that flips with that decision,
 *     and it is the one this suite would have failed on before it.
 *  2. **A positive endpoint fact is the only thing the filter can act on**, and only once asked:
 *     `laptop`/`desktop` come off the board when — and only when — `showEndpoints` is false.
 *  3. **No signal never hides anything.** Absent, `null` and the explicit `unknown` all stay on the
 *     map even with the filter applied. Every row an existing install carries the second after
 *     `prisma migrate deploy` is in that third state.
 *  4. **An old `?endpoints=1` bookmark still resolves to a board with endpoints on it.** The param
 *     kept its name and changed its value precisely so a link saved by the previous release lands
 *     on the picture its author saved, rather than on a quietly emptied map.
 *
 * Plus the boundary the CEO settled on 2026-08-03 (decision 5): endpoint hiding is **canvas-only**.
 * The Servers table keeps showing everything, and the last test in this file is what stops a future
 * refactor from quietly "fixing" that.
 */
import { ENDPOINT_CHASSIS } from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import {
  HIDE_ENDPOINTS_VALUE,
  SHOW_ENDPOINTS_PARAM,
  edgesBetweenVisible,
  partitionEndpoints,
  showEndpointsFromParam,
} from "./endpoints";

const node = (id: string, chassis?: string | null) => ({ id, chassis });
const ids = <T extends { id: string }>(nodes: T[]) => nodes.map((n) => n.id);

describe("partitionEndpoints — hiding is opt-in (ADR-0093 §5, amended)", () => {
  test("laptops and desktops come off the board once hidden; servers/VMs/containers stay", () => {
    const nodes = [
      node("laptop-1", "laptop"),
      node("desktop-1", "desktop"),
      node("srv-1", "server"),
      node("vm-1", "vm"),
      node("ctr-1", "container"),
    ];
    const { visible, endpointCount } = partitionEndpoints(nodes, false);
    expect(ids(visible)).toEqual(["srv-1", "vm-1", "ctr-1"]);
    expect(endpointCount).toBe(2);
  });

  test("the hidden set is exactly the shared vocabulary, never re-derived here", () => {
    // If `ENDPOINT_CHASSIS` ever grows a member, this canvas follows it without an edit.
    const nodes = ENDPOINT_CHASSIS.map((c) => node(c, c));
    expect(partitionEndpoints(nodes, false).visible).toEqual([]);
    expect(partitionEndpoints(nodes, false).endpointCount).toBe(
      ENDPOINT_CHASSIS.length,
    );
  });

  test("the default draws every one of them, in the original order", () => {
    const nodes = [
      node("laptop-1", "laptop"),
      node("srv-1", "server"),
      node("desktop-1", "desktop"),
    ];
    const { visible, endpointCount } = partitionEndpoints(nodes, true);
    expect(ids(visible)).toEqual(["laptop-1", "srv-1", "desktop-1"]);
    // The count is reported whether or not they are drawn — the toolbar needs it either way.
    expect(endpointCount).toBe(2);
  });

  test("hiding on an estate of nothing but endpoints empties the board rather than erroring", () => {
    const nodes = [node("l1", "laptop"), node("l2", "laptop")];
    expect(partitionEndpoints(nodes, false).visible).toEqual([]);
    expect(partitionEndpoints(nodes, false).endpointCount).toBe(2);
  });

  test("no nodes at all is not a special case", () => {
    expect(partitionEndpoints([], false)).toEqual({ visible: [], endpointCount: 0 });
    expect(partitionEndpoints([], true)).toEqual({ visible: [], endpointCount: 0 });
  });
});

describe("partitionEndpoints — NO SIGNAL IS NOT AN ENDPOINT (ADR-0093 §1)", () => {
  test("a node predating the column renders exactly as it does today", () => {
    // The three shapes an install carries the second after `prisma migrate deploy`: the column is
    // absent from an older API payload, null on every existing row, and `unknown` wherever the Linux
    // collector forced it (a container reading /sys/class/dmi sees the HOST's board).
    const nodes = [
      node("legacy-row"), // chassis absent entirely
      node("manual-node", null),
      node("no-probe", "unknown"),
    ];
    const { visible, endpointCount } = partitionEndpoints(nodes, false);
    expect(ids(visible)).toEqual(["legacy-row", "manual-node", "no-probe"]);
    expect(endpointCount).toBe(0);
  });

  test("a value a future collector invents degrades to visible, never hidden", () => {
    const { visible, endpointCount } = partitionEndpoints(
      [node("tablet-1", "tablet"), node("toaster", "toaster")],
      false,
    );
    expect(ids(visible)).toEqual(["tablet-1", "toaster"]);
    expect(endpointCount).toBe(0);
  });

  test("with no endpoint facts the two arms of the control are identical", () => {
    const nodes = [node("a", null), node("b", "server"), node("c", "unknown")];
    expect(ids(partitionEndpoints(nodes, false).visible)).toEqual(
      ids(partitionEndpoints(nodes, true).visible),
    );
  });
});

describe("showEndpointsFromParam — URL-backed, and biased to SHOWING", () => {
  test("no param at all shows endpoints — the inverted default, asserted", () => {
    // The single assertion that fails against the pre-amendment behaviour.
    expect(showEndpointsFromParam(null)).toBe(true);
    expect(showEndpointsFromParam(undefined)).toBe(true);
    expect(SHOW_ENDPOINTS_PARAM).toBe("endpoints");
  });

  test("only the exact value takes endpoints off the board", () => {
    expect(showEndpointsFromParam(HIDE_ENDPOINTS_VALUE)).toBe(false);
    expect(HIDE_ENDPOINTS_VALUE).toBe("0");
  });

  test("an old ?endpoints=1 bookmark still lands on a board WITH endpoints", () => {
    // The previous release wrote `1` to mean "show them". It still resolves to a shown board, so a
    // saved link degrades to the picture its author saved rather than to a quietly emptied map.
    expect(showEndpointsFromParam("1")).toBe(true);
  });

  test("empty, tampered or stale all degrade to shown, never to a hidden board", () => {
    for (const raw of ["", "true", "yes", "0 ", "FALSE", "no", "off"]) {
      expect(showEndpointsFromParam(raw)).toBe(true);
    }
  });
});

describe("edgesBetweenVisible — a hidden node takes its edges with it", () => {
  const edges = [
    { id: "e1", sourceId: "vm-1", targetId: "srv-1" },
    { id: "e2", sourceId: "laptop-1", targetId: "srv-1" },
    { id: "e3", sourceId: "laptop-1", targetId: "desktop-1" },
  ];

  test("an edge survives only when BOTH endpoints are on the board", () => {
    const visible = new Set(["srv-1", "vm-1"]);
    expect(ids(edgesBetweenVisible(edges, visible))).toEqual(["e1"]);
  });

  test("with everything visible the edge list is untouched", () => {
    const visible = new Set(["srv-1", "vm-1", "laptop-1", "desktop-1"]);
    expect(edgesBetweenVisible(edges, visible)).toEqual(edges);
  });

  test("an empty board draws no edges", () => {
    expect(edgesBetweenVisible(edges, new Set())).toEqual([]);
  });
});

describe("endpoint hiding is CANVAS-ONLY (ADR-0093 decision 5, 2026-08-03)", () => {
  /**
   * A settled CEO decision, asserted rather than trusted: the map is the surface that drowns at ~200
   * endpoints; the **table is not**, so the Servers list keeps showing every node. This reads the
   * source because the property being protected is an absence — the moment someone imports the filter
   * into the table "for consistency", the estate's endpoints stop being findable anywhere at all.
   * A moved or renamed file fails this loudly (the read throws) rather than passing vacuously.
   */
  const surface = (file: string) =>
    Bun.file(
      new URL(
        `../../app/(app)/assets/diagram/_components/${file}`,
        import.meta.url,
      ),
    ).text();

  test("the Servers table never filters endpoints", async () => {
    const source = await surface("servers-table-view.tsx");
    expect(source).not.toContain("partitionEndpoints");
    expect(source).not.toContain("isEndpointChassis");
    expect(source).not.toContain(SHOW_ENDPOINTS_PARAM);
  });

  test("the PENDING review tray shows chassis but never hides a proposal by it", async () => {
    const source = await surface("pending-review-tray.tsx");
    // A proposal an operator cannot see is a proposal that never gets reviewed.
    expect(source).not.toContain("partitionEndpoints");
    expect(source).not.toContain("isEndpointChassis");
  });
});
