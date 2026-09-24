import { describe, expect, test } from "bun:test";
import { AI_ENTITY_TYPES, type AiEntityRef } from "@lazyit/shared";
import { entityHref, linkableRefs } from "./entity-href";

const ref = (r: Partial<AiEntityRef> & Pick<AiEntityRef, "type" | "id">): AiEntityRef => ({
  op: "updated",
  ...r,
});

describe("entityHref", () => {
  test("maps entities with a page of their own", () => {
    expect(entityHref(ref({ type: "asset", id: "ckasset1" }))).toBe("/assets/ckasset1");
    expect(entityHref(ref({ type: "user", id: "u-1" }))).toBe("/users/u-1");
    expect(entityHref(ref({ type: "application", id: "app1" }))).toBe("/applications/app1");
    expect(entityHref(ref({ type: "location", id: "loc1" }))).toBe("/locations/loc1");
    expect(entityHref(ref({ type: "consumable", id: "c1" }))).toBe("/consumables/c1");
    expect(entityHref(ref({ type: "manualTask", id: "t1" }))).toBe("/settings/integrations/tasks/t1");
    expect(entityHref(ref({ type: "infraNode", id: "n1" }))).toBe("/assets/diagram?node=n1&focus=1");
  });

  test("routes articles by slug, and none without one", () => {
    expect(entityHref(ref({ type: "article", id: "a1", slug: "vpn-setup" }))).toBe("/kb/vpn-setup");
    expect(entityHref(ref({ type: "article", id: "a1" }))).toBeNull();
  });

  test("entities without a page open their parent's", () => {
    const parent = { type: "asset" as const, id: "as1" };
    expect(entityHref(ref({ type: "assetAssignment", id: "x", parent }))).toBe("/assets/as1");
    expect(
      entityHref(ref({ type: "accessGrant", id: "g", parent: { type: "application", id: "ap" } })),
    ).toBe("/applications/ap");
    expect(
      entityHref(ref({ type: "consumableMovement", id: "m", parent: { type: "consumable", id: "c" } })),
    ).toBe("/consumables/c");
    expect(
      entityHref(ref({ type: "workflowRun", id: "r1", parent: { type: "application", id: "ap" } })),
    ).toBe("/applications/ap/workflows/runs/r1");
    expect(entityHref(ref({ type: "workflowRun", id: "r1" }))).toBeNull();
    expect(entityHref(ref({ type: "accessRequest", id: "q" }))).toBe("/applications/access-requests");
    expect(entityHref(ref({ type: "assetAssignment", id: "x" }))).toBeNull();
  });

  test("no page: models, categories, edges, unknown types", () => {
    expect(entityHref(ref({ type: "assetModel", id: "m" }))).toBeNull();
    expect(entityHref(ref({ type: "category", id: "c" }))).toBeNull();
    expect(entityHref(ref({ type: "infraEdge", id: "e" }))).toBeNull();
    expect(entityHref({ type: "spaceship", id: "s" })).toBeNull();
  });

  test("encodes every segment — no traversal, no scheme, no second origin", () => {
    expect(entityHref(ref({ type: "asset", id: "../settings" }))).toBe("/assets/..%2Fsettings");
    expect(entityHref(ref({ type: "asset", id: "x?y=1#z" }))).toBe("/assets/x%3Fy%3D1%23z");
    expect(entityHref(ref({ type: "article", id: "a", slug: "//evil.example" }))).toBe(
      "/kb/%2F%2Fevil.example",
    );
    expect(entityHref(ref({ type: "user", id: "javascript:alert(1)" }))).toBe(
      "/users/javascript%3Aalert(1)",
    );
    expect(entityHref(ref({ type: "asset", id: "" }))).toBeNull();
    for (const type of AI_ENTITY_TYPES) {
      const href = entityHref(
        ref({ type, id: "id\r\n1", slug: "s", parent: { type: "application", id: "p" } }),
      );
      if (href !== null) {
        expect(href.startsWith("/")).toBe(true);
        expect(href.startsWith("//")).toBe(false);
        expect(/[\r\n]/.test(href)).toBe(false);
      }
    }
  });

  test("linkableRefs drops refs without a page and duplicates", () => {
    const refs = [
      ref({ type: "asset", id: "a", label: "First" }),
      ref({ type: "asset", id: "a", label: "Again" }),
      ref({ type: "assetModel", id: "m" }),
      ref({ type: "user", id: "u" }),
    ];
    expect(linkableRefs(refs).map((l) => [l.href, l.ref.label])).toEqual([
      ["/assets/a", "First"],
      ["/users/u", undefined],
    ]);
  });
});
