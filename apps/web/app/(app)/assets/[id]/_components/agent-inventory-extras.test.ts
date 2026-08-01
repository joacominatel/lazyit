/**
 * The agent-inventory projection's "extras" arm (ADR-0074 §2 amendment, issue #1138).
 *
 * `getAgentInventory` splits an agent-reported `specs` blob into the structured panels it renders and
 * an `extras` list that falls through to the **Custom fields** grid — a raw key/value dump meant for
 * things a HUMAN added to the record. Contract v2 puts two REPORT diagnostics in the node's blob
 * (`diagnostics`: what the collector could not do; `agentSkew`: what the server could not understand),
 * and the node panel feeds that blob straight in. Neither is a custom field and neither belongs in a
 * raw dump under that heading: they are machine bookkeeping about one check-in, they rewrite
 * themselves on the next report, and rendering them there would put a JSON blob on the panel of every
 * host that merely reports unprivileged. They stay out until a surface is designed for them.
 */
import { describe, expect, test } from "bun:test";
import { getAgentInventory } from "./agent-inventory-panel";

const NODE_SPECS = {
  host: { hostname: "web-03", os: { family: "linux", name: "Ubuntu" } },
  software: [{ name: "nginx", version: "1.27.0" }],
  reportedAt: "2026-07-31T12:00:00.000Z",
  diagnostics: { privileged: false, durationMs: 812, warnings: ["hardware: skipped"] },
  agentSkew: {
    droppedPaths: ["host.tpmVersion"],
    agentAhead: true,
    serverVersion: "v1.4.2",
  },
  rack: "A3",
};

/**
 * The same rule, one key later (ADR-0074 §3 amendment, issue #1141). A host whose `/etc/machine-id`
 * collided with one already in use carries `identityConflict` on its node blob, and an ARCHIVED
 * duplicate carries the `_infraMergedInto` merge provenance. Both are report/provenance bookkeeping
 * exactly like the two above — and the node panel feeds the node's blob straight into this projection,
 * so without an entry each would render as a raw JSON object under "Custom fields", on the panel of
 * precisely the host an operator is trying to make sense of.
 */
const CONFLICTED_SPECS = {
  ...NODE_SPECS,
  identityConflict: {
    reportedExternalId: "machine-id-baked",
    peerNodeId: "node-1",
    peerLabel: "web-01",
    discriminator: "SN-BETA",
    detectedAt: "2026-07-31T12:00:00.000Z",
  },
  _infraMergedInto: {
    nodeId: "node-9",
    label: "srv-app-04",
    externalId: "machine-id-baked",
    reportingSource: "agent:clone",
    at: "2026-07-31T12:00:00.000Z",
  },
};

describe("getAgentInventory — the report diagnostics are not custom fields (#1138)", () => {
  test("keeps `diagnostics` and `agentSkew` out of the custom-fields dump", () => {
    const keys = getAgentInventory(NODE_SPECS)?.extras.map(([key]) => key);
    expect(keys).not.toContain("diagnostics");
    expect(keys).not.toContain("agentSkew");
  });

  test("keeps `identityConflict` and `_infraMergedInto` out of it too (#1141)", () => {
    const keys = getAgentInventory(CONFLICTED_SPECS)?.extras.map(([key]) => key);
    expect(keys).not.toContain("identityConflict");
    expect(keys).not.toContain("_infraMergedInto");
    // Still only the human-added key — the new entries must not have swallowed anything else.
    expect(getAgentInventory(CONFLICTED_SPECS)?.extras).toEqual([["rack", "A3"]]);
  });

  test("a genuinely human-added key still falls through, so nothing else was swallowed", () => {
    expect(getAgentInventory(NODE_SPECS)?.extras).toEqual([["rack", "A3"]]);
  });

  test("the structured facts are unaffected", () => {
    const inventory = getAgentInventory(NODE_SPECS);
    expect(inventory?.host.hostname).toBe("web-03");
    expect(inventory?.software).toHaveLength(1);
    expect(inventory?.reportedAt).toBe("2026-07-31T12:00:00.000Z");
  });
});
