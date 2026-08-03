/**
 * Which "add" paths the Topology screen offers, and in which order (issue #1181).
 *
 * The Map had no path to a reporting agent at all: the wizard that mints the Service Account lived
 * only in the Table view, behind a view switch nobody signposted. Reaching it is half the fix; the
 * other half is the ORDER, and it is a product decision, not a layout one — an agent-reported node
 * self-populates, stays current and reports when it goes dark, so it leads, and the hand-drawn node
 * is the fallback for the switch, the firewall and the NAS that cannot run one.
 *
 * The two paths are gated by DIFFERENT permissions — minting the agent's Service Account needs
 * `settings:manage` (ADR-0074 §6 / ADR-0048), putting a node on the map needs `infra:manage` — so
 * every combination has to resolve to something honest rather than a dead menu entry.
 */
import { describe, expect, test } from "bun:test";
import { addNodeOptions } from "./add-node-options";

describe("addNodeOptions", () => {
  test("the agent leads when both paths are open — that inversion IS the issue", () => {
    expect(
      addNodeOptions({ canCreateAgent: true, canCreateManual: true }),
    ).toEqual(["agent", "manual"]);
  });

  test("without settings:manage only the manual path is offered", () => {
    expect(
      addNodeOptions({ canCreateAgent: false, canCreateManual: true }),
    ).toEqual(["manual"]);
  });

  test("without infra:manage only the agent path is offered", () => {
    expect(
      addNodeOptions({ canCreateAgent: true, canCreateManual: false }),
    ).toEqual(["agent"]);
  });

  test("a read-only viewer is offered nothing — the API is the real gate either way", () => {
    expect(
      addNodeOptions({ canCreateAgent: false, canCreateManual: false }),
    ).toEqual([]);
  });
});
