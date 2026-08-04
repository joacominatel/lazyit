import { describe, expect, test } from "bun:test";
import {
  AgentFleetViewSchema,
  agentVersionBucket,
  isAgentDegraded,
  summarizeAgentFleet,
  type AgentFleetNode,
} from "./agent-fleet";

/** A minimal row; each test overrides only what it is about. */
function node(over: Partial<AgentFleetNode> = {}): AgentFleetNode {
  return {
    id: "clh0000000000000000000000",
    label: "web-01",
    kind: "PHYSICAL_HOST",
    status: "ONLINE",
    pending: false,
    assetName: null,
    ipAddress: null,
    agentVersion: "v1.10.0",
    versionBucket: "current",
    osFamily: "linux",
    chassis: null,
    reportingSource: "agent:abc",
    lastReportedAt: "2026-08-04T10:00:00.000Z",
    diagnostics: null,
    degraded: false,
    ...over,
  };
}

describe("agentVersionBucket", () => {
  test("a MAJOR gap is the nag tier, not the ordinary behind tier", () => {
    expect(agentVersionBucket("v1.9.0", "v2.0.0")).toBe("majorBehind");
    expect(agentVersionBucket("v0.4.0", "v2.1.3")).toBe("majorBehind");
  });

  test("a MINOR or PATCH gap is `behind` — real, but never a nag", () => {
    expect(agentVersionBucket("v1.9.0", "v1.10.0")).toBe("behind");
    expect(agentVersionBucket("v1.10.0", "v1.10.1")).toBe("behind");
  });

  test("equal versions are current", () => {
    expect(agentVersionBucket("v1.10.0", "v1.10.0")).toBe("current");
  });

  test("an agent AHEAD of the instance is current, not a bucket of its own", () => {
    // A host rebuilt mid-upgrade legitimately runs ahead for a moment (ADR-0094 §3).
    expect(agentVersionBucket("v1.11.0", "v1.10.0")).toBe("current");
  });

  test("the describe suffix is ignored on both sides, exactly as the helpers ignore it", () => {
    expect(agentVersionBucket("v1.9.0-3-gabc1234", "v1.10.0")).toBe("behind");
    expect(agentVersionBucket("v1.10.0", "v1.10.0-3-gabc1234")).toBe("current");
  });

  // ── the fail-soft posture (ADR-0094 §3, ADR-0083/#907) ──────────────────────────────────────────

  test("`dev` is UNKNOWN, never behind — a source checkout is not nagged", () => {
    expect(agentVersionBucket("dev", "v1.10.0")).toBe("unknown");
  });

  test("a `dev` SERVER makes everything unknown — the #1203 state, stated honestly", () => {
    // Until #1203 every Docker-served binary reports `dev`; the honest output is "version unknown",
    // not a guess in either direction.
    expect(agentVersionBucket("v1.9.0", "dev")).toBe("unknown");
    expect(agentVersionBucket("dev", "dev")).toBe("unknown");
  });

  test("null / undefined / empty on either side is unknown", () => {
    expect(agentVersionBucket(null, "v1.10.0")).toBe("unknown");
    expect(agentVersionBucket(undefined, "v1.10.0")).toBe("unknown");
    expect(agentVersionBucket("", "v1.10.0")).toBe("unknown");
    expect(agentVersionBucket("v1.9.0", null)).toBe("unknown");
  });

  test("an unparseable tag is unknown, never behind", () => {
    expect(agentVersionBucket("nightly", "v1.10.0")).toBe("unknown");
    expect(agentVersionBucket("v1.9", "v1.10.0")).toBe("unknown");
  });
});

describe("isAgentDegraded", () => {
  test("no diagnostics is NOT degraded — silence is not evidence", () => {
    expect(isAgentDegraded(null)).toBe(false);
    expect(isAgentDegraded(undefined)).toBe(false);
  });

  test("a clean privileged run is not degraded", () => {
    expect(isAgentDegraded({ privileged: true, warnings: [] })).toBe(false);
  });

  test("an explicitly unprivileged run is degraded", () => {
    expect(isAgentDegraded({ privileged: false, warnings: [] })).toBe(true);
  });

  test("an unknown privilege level is not degraded (tri-state, not a falsy boolean)", () => {
    // A pre-#1138 collector says nothing about privilege; that must not read as "unprivileged".
    expect(isAgentDegraded({ privileged: null, warnings: [] })).toBe(false);
  });

  test("any warning degrades the row", () => {
    expect(
      isAgentDegraded({ privileged: true, warnings: ["dmi: permission denied"] }),
    ).toBe(true);
  });
});

describe("summarizeAgentFleet", () => {
  test("the four buckets are exclusive and sum to the total", () => {
    const summary = summarizeAgentFleet([
      node({ versionBucket: "majorBehind" }),
      node({ versionBucket: "behind" }),
      node({ versionBucket: "behind" }),
      node({ versionBucket: "unknown" }),
      node({ versionBucket: "current" }),
    ]);
    expect(summary.total).toBe(5);
    expect(
      summary.majorBehind + summary.behind + summary.unknown + summary.current,
    ).toBe(summary.total);
    expect(summary).toMatchObject({
      majorBehind: 1,
      behind: 2,
      unknown: 1,
      current: 1,
      behindTotal: 3,
    });
  });

  test("`behindTotal` is the actionable set — MAJOR plus ordinary behind", () => {
    const summary = summarizeAgentFleet([
      node({ versionBucket: "majorBehind" }),
      node({ versionBucket: "unknown" }),
    ]);
    expect(summary.behindTotal).toBe(1);
  });

  test("liveness is ORTHOGONAL to the buckets — a current host can be silent", () => {
    const summary = summarizeAgentFleet([
      node({ versionBucket: "current", status: "OFFLINE" }),
      node({ versionBucket: "current", lastReportedAt: null }),
      node({ versionBucket: "current" }),
    ]);
    expect(summary.current).toBe(3);
    expect(summary.notReporting).toBe(2);
  });

  test("a node that is both OFFLINE and never reported is counted once", () => {
    const summary = summarizeAgentFleet([
      node({ status: "OFFLINE", lastReportedAt: null }),
    ]);
    expect(summary.notReporting).toBe(1);
  });

  test("degraded is counted independently of everything else", () => {
    const summary = summarizeAgentFleet([
      node({ degraded: true }),
      node({ degraded: false }),
    ]);
    expect(summary.degraded).toBe(1);
  });

  test("an empty fleet is all zeroes, not an error", () => {
    expect(summarizeAgentFleet([])).toEqual({
      total: 0,
      majorBehind: 0,
      behind: 0,
      unknown: 0,
      current: 0,
      behindTotal: 0,
      notReporting: 0,
      degraded: 0,
    });
  });
});

describe("AgentFleetViewSchema", () => {
  test("accepts a whole view round-trip", () => {
    const view = {
      serverVersion: "v1.10.0",
      summary: summarizeAgentFleet([node()]),
      nodes: [node()],
      identities: [
        {
          id: "clh0000000000000000000001",
          name: "agent-web-01",
          isActive: true,
          lastUsedAt: null,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      identitiesNeverUsed: 1,
    };
    expect(AgentFleetViewSchema.parse(view)).toEqual(view);
  });

  test("a null osFamily is legal — the UI must show BOTH commands rather than guess", () => {
    const parsed = AgentFleetViewSchema.parse({
      serverVersion: "dev",
      summary: summarizeAgentFleet([]),
      nodes: [node({ osFamily: null, agentVersion: null, versionBucket: "unknown" })],
      identities: [],
      identitiesNeverUsed: 0,
    });
    expect(parsed.nodes[0]?.osFamily).toBeNull();
  });
});
