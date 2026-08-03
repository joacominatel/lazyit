import type { InfraImpactResponse } from "@lazyit/shared";
import { describe, expect, it } from "bun:test";
import { planImpactSummary } from "./impact-summary-plan";

function response(
  affected: InfraImpactResponse["affected"],
): InfraImpactResponse {
  return { rootId: "cktestroot0000000000000000", affected };
}

const web = {
  id: "cktestweb00000000000000000",
  label: "web-01",
  kind: "VM",
  status: "ONLINE",
  depth: 1,
} as const;
const api = {
  id: "cktestapi00000000000000000",
  label: "api-01",
  kind: "CONTAINER",
  status: "ONLINE",
  depth: 2,
} as const;
const db = {
  id: "cktestdb000000000000000000",
  label: "db-01",
  kind: "VM",
  status: "OFFLINE",
  depth: 1,
} as const;

describe("planImpactSummary", () => {
  // Issue #1182: between the click and the answer the rail used to show a `role="status"`
  // skeleton. Moving the control onto the canvas must not drop it — on a large graph "nothing
  // happened yet" reads as "the button didn't work", which is how a toggle gets clicked three
  // times. The plan names the in-flight state so the banner can render it.
  it("says the radius is still in flight until it resolves", () => {
    expect(planImpactSummary(undefined)).toEqual({ state: "loading" });
  });

  // ADR-0070 §7: an empty radius is the GOOD news, never a failed query or an empty list.
  it("reads an empty radius as the safe answer, not as an empty list", () => {
    expect(planImpactSummary(response([]))).toEqual({ state: "safe" });
  });

  // A query that FAILED also resolves to no radius, and the two must never be confused: the rail
  // read a failed impact query as `affected: []` and told the operator the node was "safe to take
  // down" — a reassurance nobody had computed. It is also not in flight, so it cannot sit on the
  // skeleton forever.
  it("never reads a failed query as either safe or in flight", () => {
    expect(planImpactSummary(undefined, true)).toEqual({ state: "failed" });
    expect(planImpactSummary(response([]), true)).toEqual({ state: "safe" });
  });

  // Issue #1182, the finding this planner exists for: highlighting answers "roughly how bad", and
  // a count answers "how many". Neither answers "WHICH ones" — a dozen glowing cards is not a list
  // an operator can scan, count or copy. The enumeration rides alongside the count, never instead
  // of it.
  it("enumerates every affected node beside the count", () => {
    const plan = planImpactSummary(response([web, api, db]));
    expect(plan.state).toBe("affected");
    if (plan.state !== "affected") return;
    expect(plan.count).toBe(3);
    expect(plan.affected.map((node) => node.id)).toEqual([
      db.id,
      web.id,
      api.id,
    ]);
  });

  // Shallowest first, then alphabetical — the immediate blast radius reads before the transitive
  // tail, which is the order the rail's list used and the order an operator triages in.
  it("orders the enumeration shallowest first, then alphabetically", () => {
    const plan = planImpactSummary(response([api, web, db]));
    if (plan.state !== "affected") throw new Error("expected an affected plan");
    expect(plan.affected.map((node) => node.label)).toEqual([
      "db-01",
      "web-01",
      "api-01",
    ]);
    expect(plan.affected.map((node) => node.depth)).toEqual([1, 1, 2]);
  });

  // The count and the list are two renderings of one answer, so they can never disagree about how
  // many nodes are affected — the same reason the canvas derives its highlight set from this one
  // response.
  it("never lets the count and the enumeration disagree", () => {
    const plan = planImpactSummary(response([web, api]));
    if (plan.state !== "affected") throw new Error("expected an affected plan");
    expect(plan.affected).toHaveLength(plan.count);
  });

  // Sorting must not mutate the query's cached array (TanStack hands us the live object).
  it("leaves the response's own array untouched", () => {
    const affected = [api, web, db];
    planImpactSummary(response(affected));
    expect(affected.map((node) => node.label)).toEqual([
      "api-01",
      "web-01",
      "db-01",
    ]);
  });
});
