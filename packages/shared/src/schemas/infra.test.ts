import { describe, expect, test } from "bun:test";
import {
  AGENT_CONTAINERS_MAX,
  AGENT_EXTERNAL_ID_MAX,
  AGENT_IDENTIFIERS_MAX,
  AGENT_SKEW_PATHS_MAX,
  AGENT_WARNINGS_MAX,
  agentReportSkewPaths,
  disambiguateExternalId,
  hostIdentityEvidence,
  IDENTITY_DISCRIMINATOR_MAX,
  identityDiscriminator,
  InfraIdentityMatchSchema,
  isClonedMachineId,
  MergeInfraNodeSchema,
  type AgentReport,
  type AgentReportHost,
  AgentReportSchema,
  containerExternalId,
  containerNodeStatus,
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraNodeDetailSchema,
  InfraNodeListItemSchema,
  InfraNodeSchema,
  InfraShortcutSchema,
  inferNodeKind,
  isContainerChildExternalId,
  IpAddressSchema,
  isPlausibleEdge,
  normalizeIdentifierValue,
  PLAUSIBLE_EDGE_TARGETS,
  osFamily,
  primaryIp,
  primaryIpv4,
  primaryIpv6,
  sanitizeIdentifierValue,
  sanitizeSerial,
  selectPrimaryMac,
  UpdateInfraNodeSchema,
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

describe("UpdateInfraNodeSchema — `assetId` DETACHES, and can do nothing else (#1117)", () => {
  test("`assetId: null` is accepted — detach is the one asset-linkage edit a patch may make", () => {
    expect(UpdateInfraNodeSchema.safeParse({ assetId: null }).success).toBe(true);
  });

  test("a cuid `assetId` is REFUSED — a patch may not re-point a node at another asset", () => {
    const r = UpdateInfraNodeSchema.safeParse({ assetId: CUID });
    expect(r.success).toBe(false);
  });

  test("the refusal EXPLAINS itself: what is refused, why, and what to do instead", () => {
    // The message is the whole feature for the operator who hits it. A bare "expected null,
    // received string" tells them the shape and nothing about the rule, so these assertions pin
    // the three things the message has to carry rather than just that a 400 happened.
    const r = UpdateInfraNodeSchema.safeParse({ assetId: CUID });
    const message = r.success ? "" : r.error.issues[0].message;
    expect(message).toContain("null"); // what IS accepted
    expect(message).toContain("orphan"); // why a re-point is refused rather than half-done
    expect(message).toContain("POST /infra/nodes"); // the route that DOES link an asset
  });

  test("every OTHER field a patch may carry is untouched by the refusal", () => {
    expect(
      UpdateInfraNodeSchema.safeParse({ label: "renamed", ipAddress: "10.0.0.5" }).success,
    ).toBe(true);
  });

  test("an empty patch is still refused (the at-least-one-key rule is unchanged)", () => {
    expect(UpdateInfraNodeSchema.safeParse({}).success).toBe(false);
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

});

// ── Skew recording: what the server did not understand (#1138) ────────────────────────────────────

/** Parse a body and diff it against its own parse — exactly what the API handler does. */
const skewOf = (body: unknown) => agentReportSkewPaths(body, AgentReportSchema.parse(body));

describe("agentReportSkewPaths — the skew recorder covers the whole body, not just the root", () => {
  test("a report the server fully understands records nothing", () => {
    expect(skewOf(V1_REPORT)).toEqual({ droppedPaths: [], coercedPaths: [] });
  });

  test("names an unknown ROOT key it dropped", () => {
    expect(skewOf({ ...V1_REPORT, deltaSince: "x", policyAck: 3 }).droppedPaths).toEqual([
      "deltaSince",
      "policyAck",
    ]);
  });

  test("names an unknown NESTED key — the realistic skew, which a root-only diff cannot see", () => {
    // Every field v2 itself added lands INSIDE a nested object, and a nested `z.object` strips
    // silently. A recorder that only diffed root keys would report "everything understood" for the
    // one shape a v3 agent is most likely to send.
    const skew = skewOf({
      ...V1_REPORT,
      host: { ...V1_REPORT.host, tpmVersion: "2.0", os: { ...V1_REPORT.host.os, edition: "LTS" } },
    });
    expect(skew.droppedPaths).toContain("host.tpmVersion");
    expect(skew.droppedPaths).toContain("host.os.edition");
  });

  test("names a COERCED enum value — a silent `.catch()` is skew too", () => {
    const skew = skewOf({
      ...V1_REPORT,
      host: {
        ...V1_REPORT.host,
        os: { ...V1_REPORT.host.os, family: "plan9" },
        virtualization: { type: "virtualbox" },
      },
    });
    // The discriminator especially: the contract requires `os.family` precisely so no consumer
    // re-derives it, so swallowing a malformed one without a trace would be self-defeating.
    expect(skew.coercedPaths).toContain("host.os.family");
    expect(skew.coercedPaths).toContain("host.virtualization.type");
  });

  test("collapses array indices, so one bad element never floods the record", () => {
    const skew = skewOf({
      ...V1_REPORT,
      host: {
        ...V1_REPORT.host,
        identifiers: [
          { kind: "machine-id", value: "abc" },
          { kind: "efi-uuid", value: "def" },
          { kind: "tpm-ek", value: "ghi" },
        ],
      },
    });
    expect(skew.coercedPaths).toEqual(["host.identifiers[].kind"]);
  });

  test("records TRUNCATION as a coercion (the bounded fields degrade, they do not reject)", () => {
    const identifiers = Array.from({ length: AGENT_IDENTIFIERS_MAX + 8 }, (_, i) => ({
      kind: "serial" as const,
      value: `SN-${i}`,
    }));
    const skew = skewOf({ ...V1_REPORT, host: { ...V1_REPORT.host, identifiers } });
    expect(skew.coercedPaths).toContain("host.identifiers[]");
  });

  test("BOUNDED — a hostile body cannot stuff the jsonb record it lands in", () => {
    const junk: Record<string, unknown> = { ...V1_REPORT };
    for (let i = 0; i < 500; i += 1) junk[`junk${i}`] = i;
    junk["x".repeat(500)] = 1;
    const skew = agentReportSkewPaths(junk, AgentReportSchema.parse(junk));
    expect(skew.droppedPaths.length).toBeLessThanOrEqual(AGENT_SKEW_PATHS_MAX);
    for (const path of skew.droppedPaths) expect(path.length).toBeLessThanOrEqual(120);
  });

  test("never throws on a non-object body (it runs beside parsing, not after it)", () => {
    expect(agentReportSkewPaths(null, null)).toEqual({ droppedPaths: [], coercedPaths: [] });
    expect(agentReportSkewPaths("nope", "nope")).toEqual({
      droppedPaths: [],
      coercedPaths: [],
    });
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
      fqdn: "dc-01.corp.example.com",
      domain: { name: "corp.example.com", joined: true },
      chassis: "vm",
      virtualization: { type: "hyperv", host: "hv-cluster-01" },
      identifiers: [
        { kind: "windows-machine-guid", value: "b1e0f2a4-4c4c-4544-0043-0010ac110002" },
        { kind: "smbios-uuid", value: "4c4c4544-0043-0010-8036-b1c04f574d32" },
      ],
      bootedAt: "2026-07-30T02:14:00.000Z",
      nics: [
        {
          name: "Ethernet",
          mac: "00:15:5d:01:02:03",
          ipv4: ["10.0.0.20"],
          ipv6: [{ address: "2001:db8::20", prefixLength: 64, scope: "global" }],
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

  test("a Windows collector has somewhere to put FQDN and domain membership", () => {
    // `host` carried only `hostname`, so a Windows collector would have had to overload it or wait
    // for a v3 — exactly the future migration §3's "one host = one node, forever" forbids.
    const parsed = AgentReportSchema.parse({
      ...V1_REPORT,
      host: {
        ...V1_REPORT.host,
        fqdn: "web-03.corp.example.com",
        domain: { name: "corp.example.com", joined: true },
      },
    });
    expect(parsed.host.fqdn).toBe("web-03.corp.example.com");
    expect(parsed.host.domain).toEqual({ name: "corp.example.com", joined: true });
  });
});

// ── identifiers[]: a canonical form per kind, and a labelled escape hatch (#1138/#1141) ───────────

describe("identifiers[].value — one canonical form per kind, so #1141 can compare across OSes", () => {
  const identifiersOf = (identifiers: unknown) =>
    AgentReportSchema.parse({ ...V1_REPORT, host: { ...V1_REPORT.host, identifiers } }).host
      .identifiers;

  test("MAC: casing and separators collapse to one form", () => {
    // The same physical host reports `AA-BB-CC-DD-EE-FF` from Windows, `aa:bb:cc:dd:ee:ff` from
    // Linux and `aabb.ccdd.eeff` from some switch agents. Unnormalized they are three hosts.
    expect(normalizeIdentifierValue("mac", "AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeIdentifierValue("mac", "aabb.ccdd.eeff")).toBe("aa:bb:cc:dd:ee:ff");
    expect(normalizeIdentifierValue("mac", " AABBCCDDEEFF ")).toBe("aa:bb:cc:dd:ee:ff");
    expect(identifiersOf([{ kind: "mac", value: "AA-BB-CC-DD-EE-FF" }])?.[0]?.value).toBe(
      "aa:bb:cc:dd:ee:ff",
    );
  });

  test("UUIDs: braces stripped, lower-cased, dashed 8-4-4-4-12", () => {
    expect(
      normalizeIdentifierValue("windows-machine-guid", "{4C4C4544-0043-0010-8036-B1C04F574D32}"),
    ).toBe("4c4c4544-0043-0010-8036-b1c04f574d32");
    expect(
      normalizeIdentifierValue("smbios-uuid", "4C4C45440043001080 36B1C04F574D32".replace(" ", "")),
    ).toBe("4c4c4544-0043-0010-8036-b1c04f574d32");
    expect(normalizeIdentifierValue("platform-uuid", "  4C4C4544-0043-0010-8036-B1C04F574D32 ")).toBe(
      "4c4c4544-0043-0010-8036-b1c04f574d32",
    );
  });

  test("serial: trimmed and internal whitespace collapsed, case PRESERVED (serials are cased)", () => {
    expect(normalizeIdentifierValue("serial", "  ABC   123  ")).toBe("ABC 123");
  });

  test("machine-id: lower-cased (the one thing that differs between readers)", () => {
    expect(normalizeIdentifierValue("machine-id", " 9F8D7C6B5A4E ")).toBe("9f8d7c6b5a4e");
  });

  test("an unrecognised kind keeps its wire label instead of vanishing into a bare `other`", () => {
    // `.catch("other")` silently relabelled, which is the opposite of `software[].source` degrading
    // to ABSENT — and left `other` inert: two identifiers of different kinds became indistinguishable.
    expect(identifiersOf([{ kind: "efi-uuid", value: "abc" }])?.[0]).toEqual({
      kind: "other",
      namespace: "efi-uuid",
      value: "abc",
    });
  });

  test("an explicit `other` carries its own namespace label", () => {
    expect(
      identifiersOf([{ kind: "other", namespace: "vendor:acme-tag", value: "A-17" }])?.[0],
    ).toEqual({ kind: "other", namespace: "vendor:acme-tag", value: "A-17" });
  });

  test("too many identifiers TRUNCATE, they never 400 the report", () => {
    const many = Array.from({ length: AGENT_IDENTIFIERS_MAX + 8 }, (_, i) => ({
      kind: "serial",
      value: `SN-${i}`,
    }));
    expect(identifiersOf(many)).toHaveLength(AGENT_IDENTIFIERS_MAX);
  });

  test("an identifier with no usable value is dropped, not rejected", () => {
    expect(identifiersOf([{ kind: "mac" }, { kind: "serial", value: "   " }])).toBeUndefined();
  });

  test("a MALFORMED element degrades the element, it does not 400 the host", () => {
    // Same posture `nics[].ipv6` already takes: a third-party or older collector sending the wrong
    // shape must not make the whole host vanish from the inventory. The bad element is dropped, the
    // good ones survive, and `agentReportSkewPaths` still records that something was not understood.
    expect(
      identifiersOf(["aa:bb:cc:dd:ee:ff", 42, null, { kind: "serial", value: "SN-1" }]),
    ).toEqual([{ kind: "serial", value: "SN-1" }]);
    expect(identifiersOf([["nested"]])).toBeUndefined();
  });

  test("a malformed element is RECORDED as skew, so degrading is never silent", () => {
    const body = {
      ...V1_REPORT,
      host: { ...V1_REPORT.host, identifiers: ["aa:bb:cc:dd:ee:ff"] },
    };
    const skew = agentReportSkewPaths(body, AgentReportSchema.parse(body));
    expect([...skew.droppedPaths, ...skew.coercedPaths].some((p) => p.startsWith("host.identifiers"))).toBe(
      true,
    );
  });
});

// ── identifiers[]: junk evidence never corroborates identity (#1138/#1141) ────────────────────────

describe("sanitizeIdentifierValue — junk never becomes corroborating identity evidence", () => {
  const identifiersOf = (identifiers: unknown) =>
    AgentReportSchema.parse({ ...V1_REPORT, host: { ...V1_REPORT.host, identifiers } }).host
      .identifiers;

  test("reuses the SERIAL junk list — dmidecode placeholders are not evidence", () => {
    // #1141 corroborates hosts by comparing these values. Two unrelated Dell boxes both reporting
    // `Default string` would match as the SAME physical host — a confidently wrong CMDB, which is
    // worse than an empty one. The `Asset.serial` path already refused these (`sanitizeSerial`);
    // the identifier path must refuse the identical strings, from the identical list.
    expect(sanitizeIdentifierValue("serial", "To be filled by O.E.M.")).toBeUndefined();
    expect(sanitizeIdentifierValue("serial", "Default string")).toBeUndefined();
    expect(sanitizeIdentifierValue("serial", "System Product Name")).toBeUndefined();
    expect(sanitizeIdentifierValue("serial", "Not Specified")).toBeUndefined();
    expect(sanitizeIdentifierValue("serial", "000000")).toBeUndefined();
    expect(sanitizeIdentifierValue("serial", "......")).toBeUndefined();
  });

  test("rejects the notorious placeholder SMBIOS UUIDs", () => {
    // Shipped verbatim on whole production runs of consumer boards — the single value most likely
    // to collide across genuinely unrelated hosts.
    expect(
      sanitizeIdentifierValue("smbios-uuid", "03000200-0400-0500-0006-000700080009"),
    ).toBeUndefined();
    expect(
      sanitizeIdentifierValue("smbios-uuid", "{03000200-0400-0500-0006-000700080009}"),
    ).toBeUndefined();
    expect(
      sanitizeIdentifierValue("platform-uuid", "00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
    expect(
      sanitizeIdentifierValue("windows-machine-guid", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"),
    ).toBeUndefined();
    expect(sanitizeIdentifierValue("machine-id", "00000000000000000000000000000000")).toBeUndefined();
  });

  test("rejects an all-zero MAC even though the separators hide the repetition", () => {
    expect(sanitizeIdentifierValue("mac", "00-00-00-00-00-00")).toBeUndefined();
  });

  test("a REAL value survives, in its canonical form", () => {
    expect(sanitizeIdentifierValue("serial", "  ABC   123  ")).toBe("ABC 123");
    expect(sanitizeIdentifierValue("mac", "AA-BB-CC-DD-EE-FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(sanitizeIdentifierValue("smbios-uuid", "{4C4C4544-0043-0010-8036-B1C04F574D32}")).toBe(
      "4c4c4544-0043-0010-8036-b1c04f574d32",
    );
    // A vendor tag under the labelled escape hatch is opaque to us — pass it through untouched.
    expect(sanitizeIdentifierValue("other", " A-17 ")).toBe("A-17");
  });

  test("junk is OMITTED from the wire set, never emitted with an empty value", () => {
    expect(
      identifiersOf([
        { kind: "serial", value: "Default string" },
        { kind: "smbios-uuid", value: "03000200-0400-0500-0006-000700080009" },
      ]),
    ).toBeUndefined();
    expect(
      identifiersOf([
        { kind: "serial", value: "To be filled by O.E.M." },
        { kind: "machine-id", value: "9F8D7C6B5A4E" },
      ]),
    ).toEqual([{ kind: "machine-id", value: "9f8d7c6b5a4e" }]);
  });
});

describe("selectPrimaryMac — WHICH mac becomes the identifier, specified and stable (#1138/#1141)", () => {
  const nics = (list: unknown) =>
    AgentReportSchema.parse({ ...V1_REPORT, host: { ...V1_REPORT.host, nics: list } }).host.nics;

  test("independent of the order the kernel happens to enumerate interfaces in", () => {
    // The collector took "whichever physical NIC `ip -j addr` listed first", i.e. ifindex order —
    // which changes across a NIC swap, a driver load order change or a udev rename. #1141 compares
    // these across reports, so the choice has to be a property of the SET, not of the listing.
    const a = nics([
      { name: "eth0", mac: "AA:BB:CC:00:00:02", isVirtual: false },
      { name: "eth1", mac: "aa:bb:cc:00:00:01", isVirtual: false },
    ]);
    const b = nics([
      { name: "eth1", mac: "aa:bb:cc:00:00:01", isVirtual: false },
      { name: "eth0", mac: "AA:BB:CC:00:00:02", isVirtual: false },
    ]);
    expect(selectPrimaryMac(a)).toBe("aa:bb:cc:00:00:01");
    expect(selectPrimaryMac(b)).toBe("aa:bb:cc:00:00:01");
  });

  test("prefers a physical, universally-administered MAC over container plumbing", () => {
    expect(
      selectPrimaryMac(
        nics([
          { name: "docker0", mac: "02:42:ac:11:00:02", isVirtual: true },
          { name: "eth0", mac: "aa:bb:cc:dd:ee:ff", isVirtual: false },
        ]),
      ),
    ).toBe("aa:bb:cc:dd:ee:ff");
  });

  test("still answers when /sys could not say which NIC is physical (locally-administered included)", () => {
    // EC2 hands out `02:…` (locally administered) MACs on real ENIs — excluding them outright would
    // leave every cloud host with no MAC evidence at all.
    expect(selectPrimaryMac(nics([{ name: "ens5", mac: "02:aa:bb:cc:dd:ee" }]))).toBe(
      "02:aa:bb:cc:dd:ee",
    );
  });

  test("ignores loopback and all-zero MACs, and answers undefined when there is nothing to pick", () => {
    expect(
      selectPrimaryMac(nics([{ name: "tun0", mac: "00:00:00:00:00:00", isVirtual: true }])),
    ).toBeUndefined();
    expect(selectPrimaryMac(undefined)).toBeUndefined();
  });
});

// ── nics[].ipv6: enough information to pick a STABLE address (#1138) ──────────────────────────────

describe("primaryIp — IPv4 first, then a stable routable IPv6 (#1138)", () => {
  const host = (nics: unknown): AgentReportHost =>
    AgentReportSchema.parse({ ...V1_REPORT, host: { hostname: "h", nics } }).host;

  test("prefers IPv4 whenever the host has one (v1 behaviour, unchanged)", () => {
    expect(
      primaryIp(host([{ name: "eth0", ipv4: ["10.0.0.12"], ipv6: [{ address: "2001:db8::1" }] }])),
    ).toBe("10.0.0.12");
  });

  test("falls back to IPv6 on a v6-only host (which used to show NO address at all)", () => {
    expect(primaryIp(host([{ name: "eth0", ipv6: [{ address: "2001:db8::5" }] }]))).toBe(
      "2001:db8::5",
    );
  });

  test("a bare string is still accepted — the contract degrades, it does not reject", () => {
    expect(primaryIp(host([{ name: "eth0", ipv6: ["2001:db8::5"] }]))).toBe("2001:db8::5");
  });

  test("NEVER promotes a temporary (privacy) address — it rotates, the map entry must not", () => {
    // RFC 4941 privacy addresses are regenerated on a timer. Promoting one puts an address on the
    // map that stops resolving to the host within hours.
    expect(
      primaryIp(
        host([
          {
            name: "eth0",
            ipv6: [
              { address: "2001:db8::dead:beef", scope: "global", temporary: true },
              { address: "2001:db8::5", scope: "global" },
            ],
          },
        ]),
      ),
    ).toBe("2001:db8::5");
  });

  test("NEVER promotes a deprecated address (its preferred lifetime has expired)", () => {
    expect(
      primaryIp(
        host([
          {
            name: "eth0",
            ipv6: [
              { address: "2001:db8::old", scope: "global", deprecated: true },
              { address: "2001:db8::5", scope: "global" },
            ],
          },
        ]),
      ),
    ).toBe("2001:db8::5");
  });

  test("skips non-global scopes and link-local, however they are expressed", () => {
    expect(
      primaryIp(
        host([
          {
            name: "eth0",
            ipv6: [
              { address: "fe80::1", scope: "link" },
              { address: "fe80::2" }, // no scope reported — the prefix still says link-local
              { address: "2001:db8::9", scope: "global" },
            ],
          },
        ]),
      ),
    ).toBe("2001:db8::9");
    expect(primaryIp(host([{ name: "eth0", ipv6: [{ address: "fe80::1" }] }]))).toBeUndefined();
  });

  test("prefers global unicast over a ULA, but takes the ULA rather than showing nothing", () => {
    expect(
      primaryIp(
        host([
          {
            name: "eth0",
            ipv6: [
              { address: "fd00:1234::7", scope: "global" },
              { address: "2001:db8::9", scope: "global" },
            ],
          },
        ]),
      ),
    ).toBe("2001:db8::9");
    expect(primaryIp(host([{ name: "eth0", ipv6: [{ address: "fd00:1234::7" }] }]))).toBe(
      "fd00:1234::7",
    );
  });

  test("drops a malformed IPv6 (validate-or-drop, ADR-0090)", () => {
    expect(primaryIp(host([{ name: "eth0", ipv6: [{ address: "2001:zz::1" }] }]))).toBeUndefined();
  });

  test("primaryIpv6 is the exported selection rule, not a private detail of primaryIp", () => {
    expect(primaryIpv6(host([{ name: "eth0", ipv6: [{ address: "2001:db8::5" }] }]))).toBe(
      "2001:db8::5",
    );
  });
});

// ── Auto-kind + container child nodes (#1139) ─────────────────────────────────────────────────────

/** A host block carrying only what the kind inference reads — the rest is irrelevant to the rule. */
function kindHost(host: Partial<AgentReportHost>): AgentReportHost {
  return AgentReportSchema.parse({ ...V1_REPORT, host: { hostname: "h", ...host } }).host;
}

describe("inferNodeKind — the CREATE-branch proposal (#1139)", () => {
  test("a POSITIVE bare-metal finding is PHYSICAL_HOST", () => {
    expect(inferNodeKind(kindHost({ virtualization: { type: "none" } }))).toBe("PHYSICAL_HOST");
  });

  test("every hypervisor is a VM — including the `other` catch-all", () => {
    for (const type of ["kvm", "vmware", "hyperv", "xen", "other"] as const) {
      expect(inferNodeKind(kindHost({ virtualization: { type } }))).toBe("VM");
    }
  });

  test("the container runtimes are CONTAINER", () => {
    for (const type of ["docker", "lxc", "wsl"] as const) {
      expect(inferNodeKind(kindHost({ virtualization: { type } }))).toBe("CONTAINER");
    }
  });

  test("NO evidence proposes nothing — the caller keeps today's default", () => {
    // "the probe did not run" is not "bare metal". Guessing here silently pre-empts the human's call.
    expect(inferNodeKind(kindHost({ chassis: "unknown" }))).toBeUndefined();
    expect(inferNodeKind(kindHost({}))).toBeUndefined();
  });

  test("chassis answers only when no virtualization block did (a non-Linux collector)", () => {
    expect(inferNodeKind(kindHost({ chassis: "vm" }))).toBe("VM");
    expect(inferNodeKind(kindHost({ chassis: "container" }))).toBe("CONTAINER");
    for (const chassis of ["server", "desktop", "laptop"] as const) {
      expect(inferNodeKind(kindHost({ chassis }))).toBe("PHYSICAL_HOST");
    }
  });

  test("virtualization WINS over chassis — a guest inherits its hypervisor's synthetic board", () => {
    expect(inferNodeKind(kindHost({ chassis: "server", virtualization: { type: "kvm" } }))).toBe(
      "VM",
    );
  });
});

describe("containerExternalId — the identity key, as permanent as the host one (#1139)", () => {
  test("scopes the container's NAME to its host's externalId", () => {
    expect(containerExternalId("9f8d7c6b", "web")).toBe("9f8d7c6b/container/web");
  });

  test("the same name on the same host is the SAME key — a recreate never mints a duplicate", () => {
    expect(containerExternalId("m1", "api")).toBe(containerExternalId("m1", "api"));
  });

  test("the same name on ANOTHER host is a DIFFERENT key", () => {
    expect(containerExternalId("m1", "api")).not.toBe(containerExternalId("m2", "api"));
  });

  test("can never collide with a host's own externalId (machine-ids carry no `/`)", () => {
    expect(containerExternalId("m1", "api")).not.toBe("m1");
    expect(containerExternalId("m1", "api")).toContain("/container/");
  });

  test("isContainerChildExternalId tells a child from the host that reported it", () => {
    // A consumer that must show THE SERVER — the create-agent wizard's "it checked in" screen —
    // needs this: children are created after their host, and the node list is newest-first, so
    // "the newest agent proposal" is a container the moment a host reports any.
    expect(isContainerChildExternalId(containerExternalId("m1", "api"))).toBe(true);
    expect(isContainerChildExternalId("9f8d7c6b5a4e3f2a")).toBe(false);
    expect(isContainerChildExternalId(null)).toBe(false);
    expect(isContainerChildExternalId(undefined)).toBe(false);
  });
});

describe("containerNodeStatus — a reported liveness fact, never curation (#1139)", () => {
  test("a running container is ONLINE", () => {
    expect(containerNodeStatus("running")).toBe("ONLINE");
  });

  test("anything the runtime says is not running is OFFLINE", () => {
    for (const state of ["exited", "dead", "paused", "created", "removing", "restarting"] as const) {
      expect(containerNodeStatus(state)).toBe("OFFLINE");
    }
  });

  test("a state this build does not recognise is UNKNOWN, never a guess", () => {
    expect(containerNodeStatus("unknown")).toBe("UNKNOWN");
    expect(containerNodeStatus(undefined)).toBe("UNKNOWN");
  });
});

describe("PLAUSIBLE_EDGE_TARGETS already anticipates the agent's edge (#1139)", () => {
  test("CONTAINER RUNS_ON PHYSICAL_HOST and CONTAINER RUNS_ON VM are both plausible", () => {
    // The agent opens exactly this edge; if the table did not already allow it every report would
    // log an "implausible edge" warning for a relationship the product was designed around.
    expect(PLAUSIBLE_EDGE_TARGETS.RUNS_ON?.CONTAINER).toContain("PHYSICAL_HOST");
    expect(isPlausibleEdge("RUNS_ON", "CONTAINER", "PHYSICAL_HOST")).toBe(true);
    expect(isPlausibleEdge("RUNS_ON", "CONTAINER", "VM")).toBe(true);
  });
});

describe("host.containers[] — additive, optional, degrade-never-reject (#1139)", () => {
  const withContainers = (containers: unknown) =>
    AgentReportSchema.parse({
      ...V1_REPORT,
      host: { ...V1_REPORT.host, containers },
    }).host.containers;

  test("carries the identity, the image and the published ports", () => {
    expect(
      withContainers([
        {
          name: "lazyit-api",
          id: "3f2a1b0c9d8e",
          image: "ghcr.io/acme/api:1.4.0",
          imageDigest: "sha256:abc123",
          state: "running",
          ports: [{ containerPort: 3001, hostPort: 8081, hostIp: "0.0.0.0", protocol: "tcp" }],
        },
      ]),
    ).toEqual([
      {
        name: "lazyit-api",
        id: "3f2a1b0c9d8e",
        image: "ghcr.io/acme/api:1.4.0",
        imageDigest: "sha256:abc123",
        state: "running",
        ports: [{ containerPort: 3001, hostPort: 8081, hostIp: "0.0.0.0", protocol: "tcp" }],
      },
    ]);
  });

  test("an unknown runtime state degrades to `unknown` — never a 400 on the whole host", () => {
    expect(withContainers([{ name: "c1", state: "hibernating" }])?.[0]?.state).toBe("unknown");
  });

  test("a nameless or malformed element is DROPPED, the rest of the host still lands", () => {
    expect(withContainers([{ name: "keep" }, { name: "  " }, "not-an-object", 7, null])).toEqual([
      { name: "keep" },
    ]);
  });

  test("the set is TRUNCATED past the cap, never rejected", () => {
    const many = Array.from({ length: AGENT_CONTAINERS_MAX + 40 }, (_, i) => ({ name: `c${i}` }));
    expect(withContainers(many)).toHaveLength(AGENT_CONTAINERS_MAX);
  });

  test("an EMPTY list is a POSITIVE finding — `this host runs no containers` (not `omitted`)", () => {
    // The distinction is load-bearing: an ABSENT key means the agent never probed and the server must
    // touch nothing, while `[]` means the probe ran and found none, which retires the child nodes.
    expect(withContainers([])).toEqual([]);
    expect(AgentReportSchema.parse(V1_REPORT).host.containers).toBeUndefined();
  });

  test("a dropped element is recorded as SKEW, so the degradation is never silent", () => {
    const raw = { ...V1_REPORT, host: { ...V1_REPORT.host, containers: [{ name: "" }] } };
    const { coercedPaths, droppedPaths } = agentReportSkewPaths(raw, AgentReportSchema.parse(raw));
    expect([...coercedPaths, ...droppedPaths].join(" ")).toContain("host.containers");
  });
});

describe("diagnostics — bounded by TRUNCATION, never by a 400 (#1138)", () => {
  test("an over-long / over-full warning list is trimmed, not rejected", () => {
    // These fields exist to serve agents that are NOT version-locked to the instance. Making them
    // the only hard 400s in the contract would defeat the amendment they belong to.
    const parsed = AgentReportSchema.parse({
      ...V1_REPORT,
      diagnostics: {
        warnings: Array.from({ length: 200 }, (_, i) => `w${i}`.padEnd(900, "x")),
        privileged: false,
        durationMs: 812,
      },
    });
    expect(parsed.diagnostics?.warnings).toHaveLength(AGENT_WARNINGS_MAX);
    for (const w of parsed.diagnostics?.warnings ?? []) expect(w.length).toBeLessThanOrEqual(300);
  });
});

/**
 * Identity corroboration (#1141) — the check that stops a cloned `/etc/machine-id` from silently
 * collapsing twelve real servers into one CMDB row. The rule is deliberately narrow, and it is
 * SILENT on absence: a pre-v2 agent (and every row stored before contract v2) carries no
 * `identifiers[]`, so "no evidence" must never read as "a different host".
 */
describe("hostIdentityEvidence — the corroborating facts, read tolerantly (#1141)", () => {
  const HOST = {
    hostname: "web-01",
    identifiers: [
      { kind: "machine-id", value: "3f2a" },
      { kind: "serial", value: "SN-ALPHA" },
      { kind: "mac", value: "AA-BB-CC-DD-EE-FF" },
      { kind: "mac", value: "00:11:22:33:44:55" },
    ],
  };

  test("extracts the serial set, the MAC set and the hostname", () => {
    const evidence = hostIdentityEvidence(HOST);
    expect(evidence.serials).toEqual(["SN-ALPHA"]);
    // Canonicalised (the Windows dash spelling folds onto the Linux one) and stable-sorted, so the
    // comparison is a property of the SET and never of report order.
    expect(evidence.macs).toEqual(["00:11:22:33:44:55", "aa:bb:cc:dd:ee:ff"]);
    expect(evidence.hostname).toBe("web-01");
  });

  test("a pre-v2 host (no identifiers) yields EMPTY sets, never a fabricated one", () => {
    // `hardware.serial` is deliberately NOT read back as identity evidence: one source of evidence,
    // not two doors onto the same comparison.
    const evidence = hostIdentityEvidence({ hostname: "web-01", hardware: { serial: "SN-ALPHA" } });
    expect(evidence.serials).toEqual([]);
    expect(evidence.macs).toEqual([]);
    expect(evidence.hostname).toBe("web-01");
  });

  test("survives garbage: a non-object host, a non-array identifiers, junk elements", () => {
    expect(hostIdentityEvidence(undefined).serials).toEqual([]);
    expect(hostIdentityEvidence("nope").macs).toEqual([]);
    expect(hostIdentityEvidence({ hostname: 7, identifiers: "x" }).hostname).toBe("");
    const junk = hostIdentityEvidence({
      hostname: "web-01",
      identifiers: [null, 42, { kind: "serial" }, { kind: "serial", value: "Default string" }],
    });
    // `Default string` is an OEM placeholder — never corroborating evidence (#1138 sanitize rule).
    expect(junk.serials).toEqual([]);
  });
});

describe("isClonedMachineId — the narrow do-not-merge rule (#1141)", () => {
  const evidence = (hostname: string, serial: string, mac: string) =>
    hostIdentityEvidence({
      hostname,
      identifiers: [
        { kind: "serial", value: serial },
        { kind: "mac", value: mac },
      ],
    });

  test("serial AND MAC both differ ⇒ two hosts share one machine-id", () => {
    expect(
      isClonedMachineId(
        evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01"),
        evidence("web-02", "SN-BETA", "aa:bb:cc:dd:ee:02"),
      ),
    ).toBe(true);
  });

  test("THE MOTIVATING CASE: a golden-image clone keeps the baked hostname and is still caught", () => {
    // "Cloned from a template" means the hostname was baked in alongside the machine-id — so a
    // hostname gate would have excused precisely the scenario this whole rule exists for. The
    // hypervisor still hands each guest its own SMBIOS serial and its own MACs, which is what makes
    // the pair two machines.
    expect(
      isClonedMachineId(
        evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01"),
        evidence("web-01", "SN-BETA", "aa:bb:cc:dd:ee:02"),
      ),
    ).toBe(true);
    // Same host, same case-folded name: hostname carries no weight in either direction.
    expect(
      isClonedMachineId(
        evidence("WEB-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01"),
        evidence("web-01", "SN-BETA", "aa:bb:cc:dd:ee:02"),
      ),
    ).toBe(true);
  });

  test("the SAME host checking in again is never a conflict", () => {
    const same = evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01");
    expect(isClonedMachineId(same, same)).toBe(false);
  });

  test("a NIC swap or a rename alone is never a conflict — the other fact still corroborates", () => {
    expect(
      isClonedMachineId(
        evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01"),
        evidence("web-renamed", "SN-ALPHA", "aa:bb:cc:dd:ee:99"),
      ),
    ).toBe(false);
    expect(
      isClonedMachineId(
        evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01"),
        evidence("web-02", "SN-BETA", "aa:bb:cc:dd:ee:01"),
      ),
    ).toBe(false);
  });

  test("a missing hostname on either side changes nothing — it is not part of the rule", () => {
    const named = evidence("web-01", "SN-ALPHA", "aa:bb:cc:dd:ee:01");
    const anonymous = hostIdentityEvidence({
      identifiers: [
        { kind: "serial", value: "SN-BETA" },
        { kind: "mac", value: "aa:bb:cc:dd:ee:02" },
      ],
    });
    expect(anonymous.hostname).toBe("");
    expect(isClonedMachineId(named, anonymous)).toBe(true);
    expect(isClonedMachineId(anonymous, named)).toBe(true);
  });

  test("SKIPS SILENTLY when either side carries no evidence — the pre-v2 upgrade promise", () => {
    const legacy = hostIdentityEvidence({ hostname: "web-01" });
    const v2 = evidence("web-02", "SN-BETA", "aa:bb:cc:dd:ee:02");
    expect(isClonedMachineId(legacy, v2)).toBe(false);
    expect(isClonedMachineId(v2, legacy)).toBe(false);
    // Half the evidence is still no evidence: a serial with no MAC cannot carry the rule alone.
    const serialOnly = hostIdentityEvidence({
      hostname: "web-03",
      identifiers: [{ kind: "serial", value: "SN-GAMMA" }],
    });
    expect(isClonedMachineId(serialOnly, v2)).toBe(false);
  });
});

describe("identityDiscriminator / disambiguateExternalId (#1141)", () => {
  test("prefers the serial, falls back to the lowest MAC, and is stable", () => {
    const withSerial = hostIdentityEvidence({
      hostname: "web-02",
      identifiers: [
        { kind: "serial", value: "SN-BETA" },
        { kind: "mac", value: "aa:bb:cc:dd:ee:02" },
      ],
    });
    expect(identityDiscriminator(withSerial)).toBe("SN-BETA");
    const macOnly = hostIdentityEvidence({
      hostname: "web-02",
      identifiers: [
        { kind: "mac", value: "ff:ff:ff:ff:ff:fe" },
        { kind: "mac", value: "aa:bb:cc:dd:ee:02" },
      ],
    });
    expect(identityDiscriminator(macOnly)).toBe("aa:bb:cc:dd:ee:02");
    expect(identityDiscriminator(hostIdentityEvidence({ hostname: "x" }))).toBeUndefined();
  });

  test("the disambiguated key is deterministic and bounded", () => {
    expect(disambiguateExternalId("machine-id-xyz", "SN-BETA")).toBe("machine-id-xyz#SN-BETA");
    expect(disambiguateExternalId("machine-id-xyz", "SN-BETA")).toBe(
      disambiguateExternalId("machine-id-xyz", "SN-BETA"),
    );
    const long = disambiguateExternalId("m".repeat(400), "s".repeat(400));
    expect(long.length).toBeLessThanOrEqual(AGENT_EXTERNAL_ID_MAX + IDENTITY_DISCRIMINATOR_MAX + 1);
    // The separator is what makes the key readable in the tray and greppable in the DB.
    expect(long).toContain("#");
  });
});

describe("MergeInfraNodeSchema — the re-key/merge-into body (#1141)", () => {
  test("requires a cuid target and refuses anything else in the body", () => {
    expect(MergeInfraNodeSchema.parse({ targetNodeId: CUID }).targetNodeId).toBe(CUID);
    expect(MergeInfraNodeSchema.safeParse({ targetNodeId: "not-a-cuid" }).success).toBe(false);
    expect(MergeInfraNodeSchema.safeParse({}).success).toBe(false);
    // Strict: the merge must never become a smuggling route for curation fields.
    expect(MergeInfraNodeSchema.safeParse({ targetNodeId: CUID, label: "x" }).success).toBe(false);
  });
});

describe("InfraIdentityMatchSchema — the re-image adoption hint (#1141)", () => {
  test("carries the peer node plus WHICH fact matched, so the UI can say why", () => {
    const match = InfraIdentityMatchSchema.parse({
      id: CUID,
      label: "srv-app-04",
      kind: "PHYSICAL_HOST",
      status: "OFFLINE",
      state: "CONFIRMED",
      matchedOn: "serial",
      value: "SN-ALPHA",
    });
    expect(match.matchedOn).toBe("serial");
    // Only the two burned-in facts are evidence for adoption — a hostname match is not.
    expect(
      InfraIdentityMatchSchema.safeParse({
        id: CUID,
        label: "x",
        kind: "PHYSICAL_HOST",
        status: "ONLINE",
        state: "PENDING",
        matchedOn: "hostname",
        value: "x",
      }).success,
    ).toBe(false);
  });
});
