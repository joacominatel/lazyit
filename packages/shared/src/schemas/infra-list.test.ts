import { describe, expect, test } from "bun:test";
import {
  INFRA_GRAPH_EDGES_MAX,
  INFRA_GRAPH_NODES_MAX,
  InfraGraphEdgesSchema,
  InfraGraphNodeSchema,
  InfraGraphSchema,
  InfraNodeListRoleSchema,
  InfraNodeListPageSchema,
} from "./infra-list";
import { InfraEdgeSchema, InfraNodeListItemSchema } from "./infra";
import { MAX_PAGE_LIMIT } from "./pagination";

/**
 * The two read contracts #1152 splits `GET /infra/nodes` into.
 *
 * What these guard: the node list becoming a `Page<T>` is only half the fix — the topology canvas
 * still needs the WHOLE graph, so it got its own endpoint. The failure this suite exists to prevent
 * is that endpoint quietly becoming a second unbounded list, or its projection drifting back into
 * carrying the joins (`owners`/`assetName`) the canvas never draws.
 */

describe("InfraNodeListPageSchema — the paged Servers list (ADR-0030)", () => {
  test("is the house Page<T> envelope over the lean list item", () => {
    const parsed = InfraNodeListPageSchema.parse({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(parsed).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  });

  test("carries the SAME item shape as the unpaged list did (no second projection)", () => {
    // The envelope is additive: whatever `InfraNodeListItemSchema` promises is what `items` holds.
    // A drift here would mean the page and the row shape were defined twice.
    expect(
      Object.keys(
        InfraNodeListPageSchema.shape.items.element.shape as Record<
          string,
          unknown
        >,
      ).sort(),
    ).toEqual(Object.keys(InfraNodeListItemSchema.shape).sort());
  });
});

describe("InfraNodeListRoleSchema — reporting identity role", () => {
  test.each(["HOST", "CHILD"])("accepts %s", (role) => {
    expect(InfraNodeListRoleSchema.parse(role)).toBe(role);
  });

  test.each(["VM", "CONTAINER", "host", "", undefined])("rejects %p", (role) => {
    expect(InfraNodeListRoleSchema.safeParse(role).success).toBe(false);
  });
});

describe("InfraGraphNodeSchema — the canvas projection", () => {
  test("carries exactly the fields the board draws, and nothing else", () => {
    expect(Object.keys(InfraGraphNodeSchema.shape).sort()).toEqual(
      ["chassis", "id", "ipAddress", "kind", "label", "status", "x", "y"].sort(),
    );
  });

  test("DROPS the joins the canvas never renders (owners / assetName / shortcuts)", () => {
    // These cost a relation join per row on a read that is polled every 40s and is deliberately
    // unpaginated. The canvas has never rendered any of them (the Servers table and the drill-in do).
    for (const field of ["owners", "assetName", "shortcuts", "specs"]) {
      expect(InfraGraphNodeSchema.shape).not.toHaveProperty(field);
    }
  });

  test("is a projection OF the node shape, so a renamed column cannot drift", () => {
    const parsed = InfraGraphNodeSchema.parse({
      id: "cxxxxxxxxxxxxxxxxxxxxxxxx",
      label: "web-01",
      kind: "VM",
      status: "ONLINE",
      ipAddress: "10.0.0.1",
      chassis: null,
      x: 10,
      y: 20,
    });
    expect(parsed.label).toBe("web-01");
  });
});

describe("InfraGraphSchema — bounded, and HONEST about it", () => {
  test("declares the cap and whether it was hit", () => {
    const parsed = InfraGraphSchema.parse({
      items: [],
      total: 0,
      limit: INFRA_GRAPH_NODES_MAX,
      truncated: false,
    });
    expect(parsed.truncated).toBe(false);
    expect(parsed.limit).toBe(INFRA_GRAPH_NODES_MAX);
  });

  test("`truncated` is REQUIRED — a caller can never mistake absent for false", () => {
    expect(
      InfraGraphSchema.safeParse({ items: [], total: 5000, limit: 2000 })
        .success,
    ).toBe(false);
  });

  test("the graph cap is far above the paged list cap (the canvas is not a page)", () => {
    // Option 2 — "let the canvas ask for limit=200" — was rejected precisely here: one ADR-0095
    // hypervisor host can enrol 500 guests, so a 200-row window would silently drop nodes AND their
    // edges off the map. The graph cap must sit well above any single host's ceiling.
    expect(INFRA_GRAPH_NODES_MAX).toBeGreaterThan(MAX_PAGE_LIMIT);
    expect(INFRA_GRAPH_NODES_MAX).toBeGreaterThan(500);
  });
});

describe("InfraGraphEdgesSchema — bounded active-edge envelope", () => {
  test("reuses InfraEdgeSchema for every item", () => {
    expect(InfraGraphEdgesSchema.shape.items.element).toBe(InfraEdgeSchema);
  });

  test("requires `truncated`", () => {
    expect(
      InfraGraphEdgesSchema.safeParse({
        items: [],
        total: 0,
        limit: INFRA_GRAPH_EDGES_MAX,
      }).success,
    ).toBe(false);
  });

  test("represents the exact 10,000-edge cap without truncation", () => {
    const parsed = InfraGraphEdgesSchema.parse({
      items: [],
      total: INFRA_GRAPH_EDGES_MAX,
      limit: INFRA_GRAPH_EDGES_MAX,
      truncated: false,
    });

    expect(parsed.limit).toBe(10_000);
    expect(parsed.total).toBe(10_000);
    expect(parsed.truncated).toBe(false);
  });
});
