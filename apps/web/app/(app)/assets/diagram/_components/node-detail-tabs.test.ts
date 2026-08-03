/**
 * The node-detail tab plan (issue #1182).
 *
 * The side rail became a tabbed modal, and the tab set has to ADAPT: a host node carries hardware,
 * disks, NICs and an installed-software list; a container child carries an image, a digest and a
 * published-ports table and no software at all. Showing every tab to every node would put an empty
 * **Software** tab on every container and an empty **Reported facts** tab on every hand-drawn switch.
 *
 * The rule these pin is the one #1139 paid for: the two `specs` projections are DISJOINT and each
 * DECLINES the other kind's blob. A tab plan that guessed — "it is an agent node, so show hardware" —
 * would put a container blob in front of the host renderer, and the host renderer's caller used to
 * fall through to a raw `JSON.stringify` dump under a heading that means "a human typed this". So the
 * plan is derived from the projections themselves, never from `source` alone, and an agent node whose
 * blob matches NEITHER arm gets no facts tab rather than an empty one.
 */
import { describe, expect, test } from "bun:test";
import { planNodeDetailTabs } from "./node-detail-tabs";

const HOST_SPECS = {
  host: {
    hostname: "web-prod-01",
    os: { name: "Debian GNU/Linux", version: "13" },
    cpu: { model: "AMD EPYC 7402P", cores: 24 },
    memoryBytes: 68719476736,
    disks: [{ device: "/dev/sda", sizeBytes: 512110190592 }],
  },
  software: [{ name: "openssl", version: "3.5.1" }],
  reportedAt: "2026-08-01T09:00:00.000Z",
};

const CONTAINER_SPECS = {
  container: {
    name: "lazyit-api",
    id: "3f2a1b0c9d8e",
    image: "ghcr.io/acme/api:1.4.0",
    imageDigest: "sha256:9f8d7c6b5a4e",
    state: "running",
    ports: [{ containerPort: 3001, hostPort: 8081, protocol: "tcp" }],
  },
  reportedAt: "2026-08-01T09:00:00.000Z",
};

describe("planNodeDetailTabs", () => {
  test("a hand-drawn node gets the three tabs that always apply, in reading order", () => {
    const plan = planNodeDetailTabs({ source: "MANUAL", specs: null });
    expect(plan.tabs).toEqual(["general", "connections", "changes"]);
    expect(plan.factsArm).toBeNull();
  });

  test("an agent host gets the reported-facts and software tabs, facts before software", () => {
    const plan = planNodeDetailTabs({ source: "AGENT", specs: HOST_SPECS });
    expect(plan.tabs).toEqual([
      "general",
      "facts",
      "software",
      "connections",
      "changes",
    ]);
    expect(plan.factsArm).toBe("host");
  });

  test("a container child gets reported facts but NO software tab", () => {
    // A container reports no package list — an empty Software tab would be a promise of a list that
    // is never coming, on the node kind that has the most of them nearby.
    const plan = planNodeDetailTabs({ source: "AGENT", specs: CONTAINER_SPECS });
    expect(plan.tabs).toEqual(["general", "facts", "connections", "changes"]);
    expect(plan.factsArm).toBe("container");
  });

  test("an agent host that reported no software list gets no software tab", () => {
    const { software: _dropped, ...noSoftware } = HOST_SPECS;
    const plan = planNodeDetailTabs({ source: "AGENT", specs: noSoftware });
    expect(plan.tabs).toEqual(["general", "facts", "connections", "changes"]);
    expect(plan.factsArm).toBe("host");
  });

  test("an agent host that reported an EMPTY software list still gets the tab", () => {
    // Empty is a fact: "this host reports packages and currently has none we could read" is a
    // different statement from "this host does not report packages", and the panel says so.
    const plan = planNodeDetailTabs({
      source: "AGENT",
      specs: { ...HOST_SPECS, software: [] },
    });
    expect(plan.tabs).toContain("software");
  });

  // ── the #1139 guard ────────────────────────────────────────────────────────────────────────────
  test("the two arms stay disjoint — a container never resolves to the host renderer", () => {
    expect(planNodeDetailTabs({ source: "AGENT", specs: CONTAINER_SPECS }).factsArm).not.toBe("host");
    expect(planNodeDetailTabs({ source: "AGENT", specs: HOST_SPECS }).factsArm).not.toBe("container");
  });

  test("an agent node whose blob matches neither arm gets NO facts tab, not an empty one", () => {
    // This is the raw-JSON-dump defect of #1139 in its new clothes: a facts tab derived from
    // `source === "AGENT"` alone would open onto a projection that correctly refuses to render.
    for (const specs of [
      null,
      {},
      { rack: "A3" },
      { host: "web-03" }, // a string, not the nested object the host arm requires
      { container: {} }, // no `name`, so the container arm declines it too
    ]) {
      const plan = planNodeDetailTabs({ source: "AGENT", specs });
      expect(plan.tabs).toEqual(["general", "connections", "changes"]);
      expect(plan.factsArm).toBeNull();
    }
  });

  test("a MANUAL node never opens a reported-facts tab, whatever is in its specs", () => {
    // Reported facts are the agent's, and the panel labels them as such. A human-authored blob that
    // happens to carry a `host` key is a custom field, not a check-in.
    const plan = planNodeDetailTabs({ source: "MANUAL", specs: HOST_SPECS });
    expect(plan.tabs).not.toContain("facts");
    expect(plan.tabs).not.toContain("software");
    expect(plan.factsArm).toBeNull();
  });

  test("every planned tab is unique and general is always the one that opens", () => {
    for (const specs of [null, HOST_SPECS, CONTAINER_SPECS]) {
      for (const source of ["MANUAL", "AGENT"] as const) {
        const { tabs } = planNodeDetailTabs({ source, specs });
        expect(new Set(tabs).size).toBe(tabs.length);
        expect(tabs[0]).toBe("general");
      }
    }
  });
});
