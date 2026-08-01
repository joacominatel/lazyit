import { describe, expect, test } from "bun:test";
import {
  AGENT_REPORT_UNKNOWN_KEYS_MAX,
  type AgentReport,
  type AgentReportHost,
  AgentReportSchema,
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraNodeDetailSchema,
  InfraNodeListItemSchema,
  InfraNodeSchema,
  InfraShortcutSchema,
  IpAddressSchema,
  isPlausibleEdge,
  osFamily,
  primaryIp,
  primaryIpv4,
  sanitizeSerial,
  unknownAgentReportKeys,
} from "./infra";

/**
 * Infra topology contract (ADR-0070). The two non-trivial bits worth a runnable check: the
 * shortcuts URL validation (a bad link must be a clean 400, not a broken canvas anchor) and the
 * edge-create DTO (required ids/kind + the self-loop refinement). The plausibility table is data
 * the API only WARNS on, so a couple of assertions pin the "absent kind / unlisted source = always
 * plausible" semantics that keep the model generic.
 */

const CUID = "clinfranode0000000000000a"; // a valid-shaped cuid for the DTO ids

describe("InfraShortcutSchema (url validation)", () => {
  test("accepts a well-formed link", () => {
    expect(
      InfraShortcutSchema.safeParse({ label: "Web UI", url: "https://nas.local:5001" }).success,
    ).toBe(true);
  });

  test("rejects a bad url", () => {
    const r = InfraShortcutSchema.safeParse({ label: "broken", url: "not a url" });
    expect(r.success).toBe(false);
  });

  test("rejects an empty label", () => {
    expect(
      InfraShortcutSchema.safeParse({ label: "", url: "https://ok.example" }).success,
    ).toBe(false);
  });
});

describe("CreateInfraNodeSchema", () => {
  test("kind + label are enough (everything else DB-defaulted)", () => {
    expect(CreateInfraNodeSchema.safeParse({ kind: "VM", label: "pve1-vm-100" }).success).toBe(
      true,
    );
  });

  test("a bad shortcut url fails the whole node create", () => {
    const r = CreateInfraNodeSchema.safeParse({
      kind: "VM",
      label: "pve1",
      shortcuts: [{ label: "ssh", url: "://nope" }],
    });
    expect(r.success).toBe(false);
  });

  test("a malformed ipAddress fails the node create (ADR-0090, #847)", () => {
    expect(
      CreateInfraNodeSchema.safeParse({ kind: "VM", label: "pve1", ipAddress: "10.0.0.256" })
        .success,
    ).toBe(false);
    expect(
      CreateInfraNodeSchema.safeParse({ kind: "VM", label: "pve1", ipAddress: "myserver" }).success,
    ).toBe(false);
  });

  test("a valid ipAddress passes and is trimmed", () => {
    const r = CreateInfraNodeSchema.safeParse({
      kind: "VM",
      label: "pve1",
      ipAddress: "  10.0.0.5  ",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.ipAddress).toBe("10.0.0.5");
  });
});

describe("InfraNodeListItemSchema (the lean list projection, #1135)", () => {
  test("omits `specs` — the list row must never carry the inventory blob", () => {
    expect(Object.keys(InfraNodeListItemSchema.shape)).not.toContain("specs");
  });

  test("keeps every OTHER node field, so the projection can only ever have dropped `specs`", () => {
    const dropped = Object.keys(InfraNodeSchema.shape).filter(
      (key) => !(key in InfraNodeListItemSchema.shape),
    );
    expect(dropped).toEqual(["specs"]);
  });

  test("the drill-in still carries `specs` — that is where the inventory panel reads it", () => {
    expect(Object.keys(InfraNodeDetailSchema.shape)).toContain("specs");
  });
});

// ── IP address value-object (ADR-0090, issue #847) ──────────────────────────────────────────────────

describe("IpAddressSchema", () => {
  test("accepts IPv4 and IPv6 (trimmed)", () => {
    expect(IpAddressSchema.parse("192.168.1.5")).toBe("192.168.1.5");
    expect(IpAddressSchema.parse("  10.0.0.5  ")).toBe("10.0.0.5"); // trim-normalized
    expect(IpAddressSchema.parse("::1")).toBe("::1");
    expect(IpAddressSchema.parse("2001:db8::1")).toBe("2001:db8::1");
  });

  test("rejects malformed addresses", () => {
    for (const bad of ["10.0.0.256", "10.0..5", "myserver", "", "999.1.1.1", "2001:zz::1"]) {
      expect(IpAddressSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("CreateInfraEdgeSchema", () => {
  test("validates a well-formed edge", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({
        sourceId: CUID,
        targetId: "clinfranode0000000000000b",
        kind: "RUNS_ON",
      }).success,
    ).toBe(true);
  });

  test("rejects a self-loop (source === target)", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({ sourceId: CUID, targetId: CUID, kind: "RUNS_ON" }).success,
    ).toBe(false);
  });

  test("rejects an unknown edge kind", () => {
    expect(
      CreateInfraEdgeSchema.safeParse({
        sourceId: CUID,
        targetId: "clinfranode0000000000000b",
        kind: "NOPE",
      }).success,
    ).toBe(false);
  });
});

describe("isPlausibleEdge (warn-only data)", () => {
  test("a mapped, listed pair is plausible (VM RUNS_ON PHYSICAL_HOST)", () => {
    expect(isPlausibleEdge("RUNS_ON", "VM", "PHYSICAL_HOST")).toBe(true);
  });

  test("a mapped, UNlisted target is implausible (CONTAINER RUNS_ON NETWORK_DEVICE)", () => {
    expect(isPlausibleEdge("RUNS_ON", "CONTAINER", "NETWORK_DEVICE")).toBe(false);
  });

  test("an unmapped source within a mapped kind is treated as plausible", () => {
    // PHYSICAL_HOST has no RUNS_ON entry → not flagged.
    expect(isPlausibleEdge("RUNS_ON", "PHYSICAL_HOST", "CLUSTER")).toBe(true);
  });

  test("an unmapped kind (DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO) is always plausible", () => {
    expect(isPlausibleEdge("DEPENDS_ON", "CONTAINER", "NETWORK_DEVICE")).toBe(true);
    expect(isPlausibleEdge("CONNECTS_TO", "VM", "STORAGE")).toBe(true);
  });
});

// ── Fact-promotion mappers (ADR-0074 §3, issue #1081) ──────────────────────────────────────────────

describe("primaryIpv4", () => {
  const host = (nics: AgentReportHost["nics"]): AgentReportHost =>
    ({ hostname: "h", nics }) as AgentReportHost;

  test("picks the first IPv4 of the first non-loopback NIC (skips `lo`)", () => {
    expect(
      primaryIpv4(
        host([
          { name: "lo", ipv4: ["127.0.0.1"] },
          { name: "eth0", ipv4: ["10.0.0.12", "10.0.0.13"] },
        ]),
      ),
    ).toBe("10.0.0.12");
  });

  test("skips a non-lo NIC that has no IPv4, uses the next one that does", () => {
    expect(
      primaryIpv4(
        host([
          { name: "eth0", mac: "aa:bb" }, // no ipv4
          { name: "eth1", ipv4: ["192.168.1.5"] },
        ]),
      ),
    ).toBe("192.168.1.5");
  });

  test("falls back to a loopback IPv4 only when no other NIC advertises one", () => {
    expect(primaryIpv4(host([{ name: "lo", ipv4: ["127.0.0.1"] }]))).toBe("127.0.0.1");
  });

  test("returns undefined when the report carries no IPv4 (partial/unprivileged)", () => {
    expect(primaryIpv4(host([{ name: "eth0" }]))).toBeUndefined();
    expect(primaryIpv4(host(undefined))).toBeUndefined();
    expect(primaryIpv4({ hostname: "h" } as AgentReportHost)).toBeUndefined();
  });

  test("drops a malformed NIC value (validate-or-drop — ADR-0090, #847)", () => {
    // A garbage primary NIC value never promotes to the node's ipAddress — dropped, never a 400 on
    // the report; a well-formed value still promotes untouched.
    expect(primaryIpv4(host([{ name: "eth0", ipv4: ["10.0.0.256"] }]))).toBeUndefined();
    expect(primaryIpv4(host([{ name: "eth0", ipv4: ["not-an-ip"] }]))).toBeUndefined();
    expect(primaryIpv4(host([{ name: "eth0", ipv4: ["10.0.0.42"] }]))).toBe("10.0.0.42");
  });
});

describe("sanitizeSerial", () => {
  const withSerial = (serial?: string): AgentReportHost =>
    ({ hostname: "h", hardware: serial === undefined ? {} : { serial } }) as AgentReportHost;

  test("accepts a real serial (trimmed)", () => {
    expect(sanitizeSerial(withSerial("  ABC123XYZ  "))).toBe("ABC123XYZ");
  });

  test("rejects the 'To be filled by O.E.M.' placeholder (case-insensitive)", () => {
    expect(sanitizeSerial(withSerial("To be filled by O.E.M."))).toBeUndefined();
    expect(sanitizeSerial(withSerial("default string"))).toBeUndefined();
    expect(sanitizeSerial(withSerial("System Product Name"))).toBeUndefined();
  });

  test("rejects empty/whitespace and all-same-char placeholders", () => {
    expect(sanitizeSerial(withSerial(""))).toBeUndefined();
    expect(sanitizeSerial(withSerial("   "))).toBeUndefined();
    expect(sanitizeSerial(withSerial("0"))).toBeUndefined();
    expect(sanitizeSerial(withSerial("000000"))).toBeUndefined();
    expect(sanitizeSerial(withSerial("......"))).toBeUndefined();
  });

  test("returns undefined when hardware/serial is absent", () => {
    expect(sanitizeSerial(withSerial(undefined))).toBeUndefined();
    expect(sanitizeSerial({ hostname: "h" } as AgentReportHost)).toBeUndefined();
  });
});

// ── Agent report contract v2 (ADR-0074 §2 amendment, issue #1138) ─────────────────────────────────

/**
 * A report exactly as a PRE-v2 (v1) agent emits it — the shape shipped by every agent binary already
 * installed in the field. Frozen here on purpose: this literal is the regression fixture for the one
 * promise contract v2 has to keep.
 */
const V1_REPORT = {
  agentVersion: "1.0.0",
  reportingSource: "agent:9f8d7c6b5a4e",
  externalId: "9f8d7c6b5a4e3f2a1b0c9d8e7f6a5b4c",
  reportedAt: "2026-07-31T12:00:00.000Z",
  host: {
    hostname: "web-03",
    os: { name: "Ubuntu", version: "24.04", kernel: "6.8.0-41-generic" },
    cpu: { model: "Xeon E5-2680", cores: 8 },
    memoryBytes: 34359738368,
    disks: [{ device: "/dev/sda", sizeBytes: 512110190592, mountpoint: "/" }],
    nics: [
      { name: "lo", ipv4: ["127.0.0.1"] },
      { name: "eth0", mac: "aa:bb:cc:dd:ee:ff", ipv4: ["10.0.0.12"] },
    ],
    hardware: {
      manufacturer: "Dell Inc.",
      model: "PowerEdge R640",
      serial: "ABC123XYZ",
    },
  },
  software: [
    { name: "nginx", version: "1.27.0" },
    { name: "openssh-server", version: "9.6p1" },
  ],
};

describe("AgentReportSchema v2 — a PRE-v2 agent still round-trips through an upgraded server", () => {
  /**
   * THE load-bearing test of #1138. lazyit is self-hosted: an operator upgrades the INSTANCE while
   * every agent in the estate keeps running the binary it was installed with. If contract v2 changed
   * what a v1 report parses to, that upgrade would either 400 the whole fleet (hosts vanish from the
   * map, the §4 liveness bit invents a fleet-wide outage) or silently mangle inventory facts. So:
   * a v1 report must parse, and must come out the OTHER side byte-identical — plus exactly ONE
   * documented addition, the `os.family` default that makes the new discriminator safe to require.
   */
  test("a v1 report parses UNCHANGED, except for the documented os.family default", () => {
    const parsed = AgentReportSchema.parse(V1_REPORT);
    expect(parsed).toEqual({
      ...V1_REPORT,
      host: { ...V1_REPORT.host, os: { ...V1_REPORT.host.os, family: "linux" } },
    });
  });

  test("a v1 report with NO os block at all parses byte-identical (nothing invented)", () => {
    // The unprivileged/degraded partial report — the shape ADR-0074 §2 promises is valid.
    const partial = {
      agentVersion: "1.0.0",
      reportingSource: "agent:minimal",
      externalId: "machine-min",
      reportedAt: "2026-07-31T12:00:00.000Z",
      host: { hostname: "tiny-01" },
    };
    expect(AgentReportSchema.parse(partial)).toEqual(partial);
  });

  test("every v1 fact-promotion mapper still reads a v1 report identically", () => {
    const parsed = AgentReportSchema.parse(V1_REPORT);
    expect(primaryIpv4(parsed.host)).toBe("10.0.0.12");
    expect(primaryIp(parsed.host)).toBe("10.0.0.12");
    expect(sanitizeSerial(parsed.host)).toBe("ABC123XYZ");
  });

  test("osFamily defaults an os-less pre-v2 report to linux (pre-v2 agents were Linux-only)", () => {
    expect(osFamily({ hostname: "tiny-01" } as AgentReportHost)).toBe("linux");
    expect(osFamily(AgentReportSchema.parse(V1_REPORT).host)).toBe("linux");
    expect(
      osFamily({ hostname: "w", os: { family: "windows" } } as AgentReportHost),
    ).toBe("windows");
  });
});

describe("AgentReportSchema v2 — forward-compat at the ROOT (the #1138 decision)", () => {
  /**
   * The root was `strictObject`, so a NEWER agent was a hard 400 against an OLDER server: the host
   * would vanish from the inventory entirely. For a CMDB, degrading beats rejecting — an inventory
   * with a hole is worse than one slightly stale on new fields. The root now behaves like every
   * NESTED object in this schema already did (plain `z.object`, which strips silently), so the
   * strictness was inconsistent rather than protective.
   */
  test("an unknown ROOT key no longer rejects the report — it is stripped", () => {
    const parsed = AgentReportSchema.safeParse({
      ...V1_REPORT,
      deltaSince: "2026-07-31T11:00:00.000Z", // a field some future agent sends (#1142)
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty("deltaSince");
  });

  test("nested objects ALREADY stripped unknown keys — the pin the root decision rests on", () => {
    const parsed = AgentReportSchema.parse({
      ...V1_REPORT,
      host: { ...V1_REPORT.host, tpmVersion: "2.0" },
    });
    expect(parsed.host).not.toHaveProperty("tpmVersion");
  });

  test("unknownAgentReportKeys names what was dropped, so the signal is MOVED, not lost", () => {
    expect(
      unknownAgentReportKeys({ ...V1_REPORT, deltaSince: "x", policyAck: 3 }),
    ).toEqual(["deltaSince", "policyAck"]);
    expect(unknownAgentReportKeys(V1_REPORT)).toEqual([]);
    // Never throws on a non-object body (the handler calls it before anything else has run).
    expect(unknownAgentReportKeys(null)).toEqual([]);
    expect(unknownAgentReportKeys("nope")).toEqual([]);
  });

  test("unknownAgentReportKeys is BOUNDED — a hostile body can't stuff the record it lands in", () => {
    const junk: Record<string, unknown> = { ...V1_REPORT };
    for (let i = 0; i < 200; i += 1) junk[`junk${i}`] = i;
    junk["x".repeat(500)] = 1;
    const keys = unknownAgentReportKeys(junk);
    expect(keys.length).toBeLessThanOrEqual(AGENT_REPORT_UNKNOWN_KEYS_MAX);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(64);
  });
});

describe("AgentReportSchema v2 — the new OS-neutral fields (#1138)", () => {
  /** A v2 report from a platform the pre-v2 contract could not describe at all. */
  const V2_REPORT: AgentReport = {
    agentVersion: "2.0.0",
    reportingSource: "agent:winhost",
    externalId: "S-1-5-21-1004336348",
    reportedAt: "2026-07-31T12:00:00.000Z",
    host: {
      hostname: "DC-01",
      os: {
        family: "windows",
        name: "Windows Server 2022",
        version: "21H2",
        kernel: "10.0.20348",
        build: "20348.2527",
      },
      chassis: "vm",
      virtualization: { type: "hyperv", host: "hv-cluster-01" },
      identifiers: [
        { kind: "windows-machine-guid", value: "b1e0…" },
        { kind: "smbios-uuid", value: "4C4C4544-0043" },
      ],
      bootedAt: "2026-07-30T02:14:00.000Z",
      nics: [
        {
          name: "Ethernet",
          mac: "00:15:5d:01:02:03",
          ipv4: ["10.0.0.20"],
          ipv6: ["2001:db8::20"],
          isVirtual: true,
        },
      ],
    },
    software: [{ name: "7-Zip", version: "23.01", source: "msi" }],
    diagnostics: { warnings: ["hardware: skipped"], privileged: false, durationMs: 812 },
    policyRevision: 7,
  };

  test("accepts the full v2 shape unchanged", () => {
    expect(AgentReportSchema.parse(V2_REPORT)).toEqual(V2_REPORT);
  });

  test("every v2 field is OPTIONAL — a bare v1-shaped host still validates", () => {
    expect(
      AgentReportSchema.safeParse({
        agentVersion: "2.0.0",
        reportingSource: "agent:x",
        externalId: "x",
        reportedAt: "2026-07-31T12:00:00.000Z",
        host: { hostname: "h" },
      }).success,
    ).toBe(true);
  });

  test("an unknown enum VALUE degrades instead of rejecting the whole report", () => {
    // Same posture as the root decision, one level down: a value we don't know must never cost the
    // operator a host. `virtualization.type` is the sharp case — `systemd-detect-virt` alone emits
    // ~30 values, and a host on one we didn't enumerate must still land on the map.
    const parsed = AgentReportSchema.parse({
      ...V1_REPORT,
      host: {
        ...V1_REPORT.host,
        chassis: "toaster",
        virtualization: { type: "virtualbox" },
        identifiers: [{ kind: "efi-uuid", value: "abc" }],
        bootedAt: "yesterday",
      },
      software: [{ name: "brew-thing", source: "nix" }],
    });
    expect(parsed.host.virtualization?.type).toBe("other");
    expect(parsed.host.identifiers?.[0]).toEqual({ kind: "other", value: "abc" });
    expect(parsed.host.chassis).toBeUndefined();
    expect(parsed.host.bootedAt).toBeUndefined();
    expect(parsed.software?.[0]).toEqual({ name: "brew-thing" });
  });

  test("an unparseable os.family degrades to `other` (the report survives)", () => {
    const parsed = AgentReportSchema.parse({
      ...V1_REPORT,
      host: { ...V1_REPORT.host, os: { family: "plan9", name: "Plan 9" } },
    });
    expect(parsed.host.os?.family).toBe("other");
  });
});

describe("primaryIp — IPv4 first, IPv6 fallback (#1138)", () => {
  const host = (nics: AgentReportHost["nics"]): AgentReportHost =>
    ({ hostname: "h", nics }) as AgentReportHost;

  test("prefers IPv4 whenever the host has one (v1 behaviour, unchanged)", () => {
    expect(
      primaryIp(
        host([
          { name: "eth0", ipv4: ["10.0.0.12"], ipv6: ["2001:db8::1"] },
        ] as AgentReportHost["nics"]),
      ),
    ).toBe("10.0.0.12");
  });

  test("falls back to IPv6 on a v6-only host (which used to show NO address at all)", () => {
    expect(
      primaryIp(host([{ name: "eth0", ipv6: ["2001:db8::5"] }] as AgentReportHost["nics"])),
    ).toBe("2001:db8::5");
  });

  test("skips link-local IPv6 — it is not an address the host is reachable at", () => {
    expect(
      primaryIp(
        host([
          { name: "eth0", ipv6: ["fe80::1", "2001:db8::9"] },
        ] as AgentReportHost["nics"]),
      ),
    ).toBe("2001:db8::9");
    expect(
      primaryIp(host([{ name: "eth0", ipv6: ["fe80::1"] }] as AgentReportHost["nics"])),
    ).toBeUndefined();
  });

  test("drops a malformed IPv6 (validate-or-drop, ADR-0090)", () => {
    expect(
      primaryIp(host([{ name: "eth0", ipv6: ["2001:zz::1"] }] as AgentReportHost["nics"])),
    ).toBeUndefined();
  });
});
