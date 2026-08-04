/**
 * `?view` — the param that decides what the Topology screen shows at all (#760, ADR-0094 §4).
 *
 * The rule under test is the failure one: an unrecognised value must land on the Map, never on an
 * error and never on nothing. A third view joining the set is exactly when that rule is most likely
 * to be re-written by hand into `raw === "table" ? … : …` and lose a case.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOPOLOGY_VIEW,
  TOPOLOGY_VIEWS,
  topologyViewFromParam,
  topologyViewParam,
} from "./topology-view";

describe("topologyViewFromParam", () => {
  test("keeps every view the toggle offers", () => {
    for (const view of TOPOLOGY_VIEWS) {
      expect(topologyViewFromParam(view)).toBe(view);
    }
    expect(TOPOLOGY_VIEWS).toEqual(["map", "table", "agents"]);
  });

  test("anything else degrades to the Map", () => {
    for (const raw of [null, undefined, "", "Agents", "fleet", "table ", "🙂"]) {
      expect(topologyViewFromParam(raw)).toBe(DEFAULT_TOPOLOGY_VIEW);
    }
  });
});

describe("topologyViewParam", () => {
  test("the default is written as an absent param, the others by name", () => {
    expect(topologyViewParam("map")).toBeUndefined();
    expect(topologyViewParam("table")).toBe("table");
    expect(topologyViewParam("agents")).toBe("agents");
  });

  test("round-trips: what is written is what is read back", () => {
    for (const view of TOPOLOGY_VIEWS) {
      expect(topologyViewFromParam(topologyViewParam(view) ?? null)).toBe(view);
    }
  });
});
