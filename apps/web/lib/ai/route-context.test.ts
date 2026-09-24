import { describe, expect, test } from "bun:test";
import { routeContext } from "./route-context";

describe("routeContext", () => {
  test("an entity page carries its entity", () => {
    expect(routeContext("/assets/ckabc123")).toEqual({
      route: "/assets/ckabc123",
      entity: { type: "asset", id: "ckabc123" },
    });
    expect(routeContext("/users/9b1f-44")).toEqual({
      route: "/users/9b1f-44",
      entity: { type: "user", id: "9b1f-44" },
    });
    expect(routeContext("/applications/app1/edit")?.entity).toEqual({ type: "application", id: "app1" });
    expect(routeContext("/locations/l1")?.entity?.type).toBe("location");
    expect(routeContext("/consumables/c1")?.entity?.type).toBe("consumable");
  });

  test("collection pages and other routes carry the route only", () => {
    expect(routeContext("/assets")).toEqual({ route: "/assets" });
    expect(routeContext("/assets/new")).toEqual({ route: "/assets/new" });
    expect(routeContext("/assets/diagram")).toEqual({ route: "/assets/diagram" });
    expect(routeContext("/applications/access-requests")).toEqual({
      route: "/applications/access-requests",
    });
    expect(routeContext("/kb/vpn-setup")).toEqual({ route: "/kb/vpn-setup" });
    expect(routeContext("/dashboard")).toEqual({ route: "/dashboard" });
  });

  test("never sends query strings, fragments or odd ids", () => {
    expect(routeContext("/assets/a1?tab=history#x")).toEqual({
      route: "/assets/a1",
      entity: { type: "asset", id: "a1" },
    });
    expect(routeContext("/assets/a%20b")).toEqual({ route: "/assets/a%20b" });
  });

  test("not an app path → null", () => {
    expect(routeContext(null)).toBeNull();
    expect(routeContext("")).toBeNull();
    expect(routeContext("assets/1")).toBeNull();
  });

  test("the route is bounded to the contract's 2048 characters", () => {
    expect(routeContext(`/${"a".repeat(5000)}`)!.route.length).toBe(2048);
  });
});
