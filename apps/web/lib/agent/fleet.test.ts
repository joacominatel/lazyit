/**
 * The fleet view's pure rules (ADR-0094 §4/§5/§7, issue #1207).
 *
 * Three of these tests exist because of a specific way this surface can lie to an operator at scale:
 * picking the wrong platform for a host (the #1168 bug, one layer out), disagreeing with the summary
 * line printed directly above the table, and putting a token — or a host that was never behind — on
 * the clipboard.
 *
 * The nullable path is asserted throughout rather than in one "degenerate" block: on an estate that
 * predates #1203 EVERY row has a null `agentVersion`, an unknown OS family and possibly no report at
 * all, so that is the normal case this view opens on, not an edge case.
 */
import { describe, expect, test } from "bun:test";
import type { AgentFleetNode, AgentOsFamily } from "@lazyit/shared";
import { AgentOsFamilySchema, summarizeAgentFleet } from "@lazyit/shared";
import {
  AGENT_FLEET_FILTERS,
  agentFleetFilterFromParam,
  agentFleetUpdateGroups,
  agentFleetUpdateScript,
  agentPlatformIsAmbiguous,
  agentPlatformsFor,
  filterAgentFleetNodes,
  isAgentUpdatable,
  isNotReportingNode,
} from "./fleet";

const ORIGIN = "https://lazyit.example.com";

/** A row with everything absent — the shape an estate full of pre-#1203 agents actually returns. */
function node(overrides: Partial<AgentFleetNode> = {}): AgentFleetNode {
  return {
    id: "cuid0000000000000000000",
    label: "host",
    kind: "PHYSICAL_HOST",
    status: "ONLINE",
    pending: false,
    assetName: null,
    ipAddress: null,
    agentVersion: null,
    versionBucket: "unknown",
    osFamily: null,
    chassis: null,
    reportingSource: null,
    lastReportedAt: "2026-08-04T10:00:00.000Z",
    diagnostics: null,
    degraded: false,
    ...overrides,
  };
}

describe("agentPlatformsFor — evidence, never a guess (ADR-0094 §5)", () => {
  test("a reported linux or windows family picks exactly one command", () => {
    expect(agentPlatformsFor("linux")).toEqual(["linux"]);
    expect(agentPlatformsFor("windows")).toEqual(["windows"]);
    expect(agentPlatformIsAmbiguous("linux")).toBe(false);
    expect(agentPlatformIsAmbiguous("windows")).toBe(false);
  });

  test("everything else shows BOTH — null, absent, and every family with no agent build", () => {
    // There is no darwin or bsd agent binary (ADR-0074 §6 builds linux + windows only), so those are
    // not "show the macOS command", they are "lazyit does not know what to run here". And a null
    // family is the pre-#1138 / never-re-reported row, which is most of an estate on upgrade day.
    for (const family of [null, undefined, "darwin", "bsd", "other"] as const) {
      expect(agentPlatformsFor(family as AgentOsFamily | null)).toEqual([
        "linux",
        "windows",
      ]);
      expect(agentPlatformIsAmbiguous(family as AgentOsFamily | null)).toBe(true);
    }
  });

  test("every family the contract can carry is handled — no silent hole", () => {
    // Asserted against the shared enum rather than a list copied here, so a sixth family added to
    // the report contract cannot quietly fall through to something this module never considered.
    for (const family of AgentOsFamilySchema.options) {
      const platforms = agentPlatformsFor(family);
      expect(platforms.length).toBeGreaterThan(0);
      for (const platform of platforms) {
        expect(["linux", "windows"]).toContain(platform);
      }
    }
  });
});

describe("agentFleetFilterFromParam — a bad param never hides a host", () => {
  test("keeps what it knows", () => {
    for (const filter of AGENT_FLEET_FILTERS) {
      expect(agentFleetFilterFromParam(filter)).toBe(filter);
    }
  });

  test("degrades to ALL, not to an empty table", () => {
    for (const raw of [null, undefined, "", "MAJORBEHIND", "🙂", "current "]) {
      expect(agentFleetFilterFromParam(raw)).toBe("ALL");
    }
  });
});

describe("filterAgentFleetNodes", () => {
  const rows = [
    node({ id: "a", label: "web-01", versionBucket: "majorBehind", osFamily: "linux" }),
    node({ id: "b", label: "web-02", versionBucket: "behind", osFamily: "linux" }),
    node({ id: "c", label: "dc-01", versionBucket: "current", osFamily: "windows" }),
    node({ id: "d", label: "old-01", versionBucket: "unknown", status: "OFFLINE" }),
    node({ id: "e", label: "never-01", versionBucket: "unknown", lastReportedAt: null }),
    node({
      id: "f",
      label: "web-03",
      versionBucket: "current",
      degraded: true,
      diagnostics: { privileged: false, warnings: [] },
    }),
  ];

  test("ALL keeps every row", () => {
    expect(filterAgentFleetNodes(rows, { q: "", filter: "ALL" })).toHaveLength(rows.length);
  });

  test("each version bucket keeps exactly its own rows", () => {
    expect(
      filterAgentFleetNodes(rows, { q: "", filter: "majorBehind" }).map((n) => n.id),
    ).toEqual(["a"]);
    expect(filterAgentFleetNodes(rows, { q: "", filter: "behind" }).map((n) => n.id)).toEqual(["b"]);
    expect(filterAgentFleetNodes(rows, { q: "", filter: "unknown" }).map((n) => n.id)).toEqual([
      "d",
      "e",
    ]);
    expect(filterAgentFleetNodes(rows, { q: "", filter: "current" }).map((n) => n.id)).toEqual([
      "c",
      "f",
    ]);
  });

  test("notReporting is OFFLINE *or* never-reported, and is orthogonal to the buckets", () => {
    expect(
      filterAgentFleetNodes(rows, { q: "", filter: "notReporting" }).map((n) => n.id),
    ).toEqual(["d", "e"]);
    expect(filterAgentFleetNodes(rows, { q: "", filter: "degraded" }).map((n) => n.id)).toEqual([
      "f",
    ]);
  });

  test("the filter agrees with the summary printed above it", () => {
    // The one invariant that keeps the view honest: clicking "31 behind" must produce 31 rows. The
    // counts come from the shared tally, the rows from this module, and nothing else holds them
    // together.
    const summary = summarizeAgentFleet(rows);
    for (const bucket of ["majorBehind", "behind", "unknown", "current"] as const) {
      expect(filterAgentFleetNodes(rows, { q: "", filter: bucket })).toHaveLength(summary[bucket]);
    }
    expect(filterAgentFleetNodes(rows, { q: "", filter: "notReporting" })).toHaveLength(
      summary.notReporting,
    );
    expect(filterAgentFleetNodes(rows, { q: "", filter: "degraded" })).toHaveLength(
      summary.degraded,
    );
    expect(rows.filter(isNotReportingNode)).toHaveLength(summary.notReporting);
  });

  test("the needle matches label, asset, IP, version and reporting source — and tolerates nulls", () => {
    const searchable = [
      node({ id: "1", label: "web-01" }),
      node({ id: "2", label: "x", assetName: "Dell R740" }),
      node({ id: "3", label: "x", ipAddress: "10.0.0.7" }),
      node({ id: "4", label: "x", agentVersion: "1.9.3" }),
      node({ id: "5", label: "x", reportingSource: "agent:linux" }),
      node({ id: "6", label: "x" }),
    ];
    expect(filterAgentFleetNodes(searchable, { q: "WEB-01", filter: "ALL" }).map((n) => n.id)).toEqual(["1"]);
    expect(filterAgentFleetNodes(searchable, { q: "r740", filter: "ALL" }).map((n) => n.id)).toEqual(["2"]);
    expect(filterAgentFleetNodes(searchable, { q: "10.0.0", filter: "ALL" }).map((n) => n.id)).toEqual(["3"]);
    expect(filterAgentFleetNodes(searchable, { q: "1.9", filter: "ALL" }).map((n) => n.id)).toEqual(["4"]);
    expect(filterAgentFleetNodes(searchable, { q: "agent:", filter: "ALL" }).map((n) => n.id)).toEqual(["5"]);
    // A row with nothing but a label never throws and never matches something it does not carry.
    expect(filterAgentFleetNodes(searchable, { q: "zzz", filter: "ALL" })).toEqual([]);
    expect(filterAgentFleetNodes(searchable, { q: "   ", filter: "ALL" })).toHaveLength(6);
  });
});

describe("isAgentUpdatable — the only gate on the update affordance (ADR-0094 §8)", () => {
  test("behind and a MAJOR behind, and nothing else", () => {
    expect(isAgentUpdatable({ versionBucket: "majorBehind" })).toBe(true);
    expect(isAgentUpdatable({ versionBucket: "behind" })).toBe(true);
    // `unknown` is NOT actionable. On an estate that predates #1203 it is most of the fleet, and an
    // update prompt on a guess is worse than silence.
    expect(isAgentUpdatable({ versionBucket: "unknown" })).toBe(false);
    expect(isAgentUpdatable({ versionBucket: "current" })).toBe(false);
  });
});

describe("agentFleetUpdateGroups — the bulk handoff (ADR-0094 §7)", () => {
  const rows = [
    node({ label: "web-01", versionBucket: "behind", osFamily: "linux" }),
    node({ label: "web-02", versionBucket: "majorBehind", osFamily: "linux" }),
    node({ label: "dc-01", versionBucket: "behind", osFamily: "windows" }),
    node({ label: "mystery-01", versionBucket: "behind", osFamily: null }),
    node({ label: "fine-01", versionBucket: "current", osFamily: "linux" }),
    node({ label: "quiet-01", versionBucket: "unknown", osFamily: "linux" }),
  ];

  test("groups by platform, one command per group, behind hosts only", () => {
    const groups = agentFleetUpdateGroups(rows, ORIGIN);
    expect(groups.map((g) => g.platform)).toEqual(["linux", "windows"]);
    expect(groups[0]?.hosts.map((h) => h.label)).toEqual(["web-01", "web-02", "mystery-01"]);
    expect(groups[1]?.hosts.map((h) => h.label)).toEqual(["dc-01", "mystery-01"]);
    // A current host and an unknown-version host are never in an update list. Both are named here
    // because both would be a silent, fleet-wide re-install of hosts nobody asked to touch.
    for (const group of groups) {
      expect(group.hosts.map((h) => h.label)).not.toContain("fine-01");
      expect(group.hosts.map((h) => h.label)).not.toContain("quiet-01");
    }
  });

  test("an unknown OS family is listed under both platforms and marked, never dropped", () => {
    const groups = agentFleetUpdateGroups(rows, ORIGIN);
    for (const group of groups) {
      expect(group.hosts.find((h) => h.label === "mystery-01")?.osKnown).toBe(false);
    }
    expect(groups[0]?.hosts.find((h) => h.label === "web-01")?.osKnown).toBe(true);
  });

  test("an empty platform group is omitted, and an empty behind-set produces nothing", () => {
    const linuxOnly = agentFleetUpdateGroups(
      [node({ label: "web-01", versionBucket: "behind", osFamily: "linux" })],
      ORIGIN,
    );
    expect(linuxOnly.map((g) => g.platform)).toEqual(["linux"]);
    expect(agentFleetUpdateGroups([node({ versionBucket: "current" })], ORIGIN)).toEqual([]);
    expect(agentFleetUpdateGroups([], ORIGIN)).toEqual([]);
  });

  test("the command is the shared builder's, so the http opt-in rides along", () => {
    const groups = agentFleetUpdateGroups(rows, "http://192.168.1.9:8080");
    expect(groups[0]?.command).toContain("--allow-insecure-http");
    expect(groups[1]?.command).toContain("-AllowInsecureHttp");
    expect(agentFleetUpdateGroups(rows, ORIGIN)[0]?.command).not.toContain("--allow-insecure-http");
  });
});

describe("agentFleetUpdateScript — what lands on the clipboard", () => {
  const groups = agentFleetUpdateGroups(
    [
      node({ label: "web-01", versionBucket: "behind", osFamily: "linux" }),
      node({ label: "dc-01", versionBucket: "majorBehind", osFamily: "windows" }),
    ],
    ORIGIN,
  );
  const copy = {
    headline: "lazyit agent update — 2 hosts behind (server 1.10.0)",
    tokenNote: "No token: both installers read it from LAZYIT_TOKEN.",
    hostsLine: (group: { platform: string; hosts: { label: string }[] }) =>
      `${group.platform}: ${group.hosts.map((h) => h.label).join(", ")}`,
  };

  test("every annotation is a comment in BOTH sh and PowerShell", () => {
    const script = agentFleetUpdateScript(groups, copy);
    for (const line of script.split("\n")) {
      if (line === "" || line.startsWith("# ")) continue;
      // Whatever is left must be an actual command, not stray prose that would execute.
      expect(line.startsWith("curl ") || line.startsWith("& (")).toBe(true);
    }
    expect(script).toContain("# lazyit agent update — 2 hosts behind (server 1.10.0)");
    expect(script).toContain("# linux: web-01");
    expect(script).toContain("# windows: dc-01");
  });

  test("carries no token, and no placeholder standing in for one", () => {
    const script = agentFleetUpdateScript(groups, copy);
    expect(script).not.toContain("lzit_sa_");
    expect(script).not.toMatch(/-{1,2}[Tt]oken\b/);
    expect(script).not.toContain("<token>");
  });

  test("a multi-line host label cannot break out of its comment", () => {
    // Node labels are free text an agent reported. A newline in one would turn the rest of a comment
    // into a line the operator's shell tries to run.
    const nasty = agentFleetUpdateGroups(
      [node({ label: "web\n01\trm -rf /", versionBucket: "behind", osFamily: "linux" })],
      ORIGIN,
    );
    expect(nasty[0]?.hosts[0]?.label).toBe("web 01 rm -rf /");
    const script = agentFleetUpdateScript(nasty, copy);
    expect(script.split("\n").filter((line) => line.includes("rm -rf /"))).toHaveLength(1);
    expect(script).toContain("# linux: web 01 rm -rf /");
  });
});

describe("the estate this view actually opens on — no version, no system, no report", () => {
  // The upgrade-day state (ADR-0094 §2/§10): agents that predate version stamping report `dev`, so
  // the row carries a null agentVersion, the OS family may never have been projected, and a host
  // that stopped reporting has no timestamp at all. Asserted as one block because "renders when
  // everything is absent" is a requirement of this feature, not a degenerate case of it.
  const blank = [
    node({ id: "1" }),
    node({ id: "2", status: "OFFLINE", lastReportedAt: null }),
    node({ id: "3", lastReportedAt: null }),
  ];

  test("nothing throws, nothing is hidden, and nothing is offered as actionable", () => {
    expect(filterAgentFleetNodes(blank, { q: "", filter: "ALL" })).toHaveLength(3);
    expect(filterAgentFleetNodes(blank, { q: "", filter: "unknown" })).toHaveLength(3);
    expect(filterAgentFleetNodes(blank, { q: "web", filter: "ALL" })).toEqual([]);
    // One is OFFLINE and one has never reported; the third is checking in fine and is NOT counted
    // as silent just because its version cannot be compared. Those are two different facts.
    expect(
      filterAgentFleetNodes(blank, { q: "", filter: "notReporting" }).map((n) => n.id),
    ).toEqual(["2", "3"]);
    expect(summarizeAgentFleet(blank)).toMatchObject({
      total: 3,
      unknown: 3,
      behindTotal: 0,
      notReporting: 2,
      degraded: 0,
    });
    // The whole update surface stays silent: no group, no script, no button on any row.
    expect(blank.some(isAgentUpdatable)).toBe(false);
    expect(agentFleetUpdateGroups(blank, ORIGIN)).toEqual([]);
  });

  test("a host that IS behind with everything else absent still gets both commands", () => {
    const groups = agentFleetUpdateGroups(
      [node({ label: "mystery", versionBucket: "behind", lastReportedAt: null })],
      ORIGIN,
    );
    expect(groups.map((group) => group.platform)).toEqual(["linux", "windows"]);
    for (const group of groups) {
      expect(group.hosts).toEqual([{ label: "mystery", osKnown: false }]);
    }
  });
});
