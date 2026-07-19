import { describe, expect, test } from "bun:test";
import {
  type AgentReportHost,
  CreateInfraEdgeSchema,
  CreateInfraNodeSchema,
  InfraShortcutSchema,
  IpAddressSchema,
  isPlausibleEdge,
  primaryIpv4,
  sanitizeSerial,
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
