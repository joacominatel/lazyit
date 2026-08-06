import { describe, expect, test } from "bun:test";
import { AGENT_POLICY_DEFAULT, AgentReportSchema, type AgentPolicy } from "@lazyit/shared";
import {
  buildHypervGuests,
  collectHypervisorWindows,
  HYPERV_GUESTS_SCRIPT,
  hypervGuid,
  parseHypervBlob,
  type HypervGuestsBlob,
} from "./hypervisor-windows";
import { buildWindowsFactsScript } from "./windows";

/**
 * ADR-0095 (#1217) — the Hyper-V half. Same testing posture as `windows.test.ts`: CI is Linux and
 * the developers are on macOS, so every mapper is pure over a captured fixture and the one PowerShell
 * boundary takes an injected exec. Detection rides the EXISTING facts sweep (one `hyperv=$hv` key),
 * so a non-Hyper-V Windows host pays zero extra interpreter starts; the guest sweep is a SECOND
 * document that only a detected host ever runs.
 */

/** Build a policy from the built-in default plus the one thing a test is about. */
function policy(patch: Partial<AgentPolicy>): AgentPolicy {
  return { ...AGENT_POLICY_DEFAULT, ...patch };
}

/** A warnings sink, so a test can assert what an operator would SEE (#1138). */
function sink(): { warn: (m: string) => void; notes: string[] } {
  const notes: string[] = [];
  return { warn: (m: string) => notes.push(m), notes };
}

/** A representative Hyper-V host document: two VMs, separator-less MACs, braced BIOSGUIDs. */
function blob(patch: Partial<HypervGuestsBlob> = {}): HypervGuestsBlob {
  return {
    vms: [
      {
        Id: "9F86D081-1234-4B10-8034-B4C04F524D33",
        Name: "dc01",
        State: "Running",
        Cores: 4,
        MemoryBytes: 4294967296,
      },
      {
        Id: "0A1B2C3D-5678-4E5F-9012-ABCDEF012345",
        Name: "sql01",
        State: "Off",
        Cores: 8,
        MemoryBytes: 0,
      },
    ],
    nics: [
      { Id: "9F86D081-1234-4B10-8034-B4C04F524D33", Mac: "00155D0A2B01" },
      { Id: "9F86D081-1234-4B10-8034-B4C04F524D33", Mac: "00155D0A2B02" },
      { Id: "0A1B2C3D-5678-4E5F-9012-ABCDEF012345", Mac: "00155D0A2B03" },
    ],
    bios: [
      { Id: "{9F86D081-1234-4B10-8034-B4C04F524D33}", BiosGuid: "{11112222-3333-4444-5555-666677778888}" },
      { Id: "{0A1B2C3D-5678-4E5F-9012-ABCDEF012345}", BiosGuid: "{AAAA1111-BBBB-4CCC-8DDD-EEEEFFFF0000}" },
    ],
    errors: [],
    ...patch,
  };
}

// ── Detection rides the facts sweep (never CPUID/manufacturer strings) ────────────────────────────

describe("Hyper-V detection in buildWindowsFactsScript (ADR-0095 §2)", () => {
  test("the default policy probes the vmms service and the virtualization namespace", () => {
    const script = buildWindowsFactsScript(AGENT_POLICY_DEFAULT);
    expect(script).toContain("Get-Service -Name vmms");
    expect(script).toContain("root\\virtualization\\v2");
    expect(script).toContain("hyperv=$hv");
  });

  test("collect.hypervisor=false: the detection section is NOT in the script the host runs", () => {
    const script = buildWindowsFactsScript(
      policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, hypervisor: false } }),
    );
    expect(script).not.toContain("vmms");
    expect(script).not.toContain("$hv");
  });

  test("detection never reads the manufacturer/model strings — the host's OWN root partition reports 'Microsoft Hv' too", () => {
    // The classic false positive the ADR names: CPUID and the SMBIOS vendor strings say Hyper-V on
    // the HOST as well as in guests. The predicate is the management stack, nothing else.
    const script = buildWindowsFactsScript(AGENT_POLICY_DEFAULT);
    expect(script).not.toContain("Microsoft Hv");
  });
});

// ── The second document ───────────────────────────────────────────────────────────────────────────

describe("HYPERV_GUESTS_SCRIPT", () => {
  test("keeps the windows-script invariants: single quotes, ASCII, errors LAST, one JSON document", () => {
    expect(HYPERV_GUESTS_SCRIPT).not.toContain('"');
    expect([...HYPERV_GUESTS_SCRIPT].filter((c) => (c.codePointAt(0) ?? 0) > 0x7f)).toEqual([]);
    expect(HYPERV_GUESTS_SCRIPT.endsWith("|ConvertTo-Json -Compress -Depth 4")).toBe(true);
    expect(HYPERV_GUESTS_SCRIPT.indexOf("errors=@($Error|")).toBeGreaterThan(
      HYPERV_GUESTS_SCRIPT.indexOf("bios=$bios"),
    );
  });

  test("collects the three sources the mapper joins: Get-VM, Get-VMNetworkAdapter, BIOSGUID", () => {
    expect(HYPERV_GUESTS_SCRIPT).toContain("Get-VM|");
    expect(HYPERV_GUESTS_SCRIPT).toContain("Get-VMNetworkAdapter");
    expect(HYPERV_GUESTS_SCRIPT).toContain("Msvm_VirtualSystemSettingData");
    // Realized systems only — a snapshot's settings data would duplicate every VM's BIOSGUID row.
    expect(HYPERV_GUESTS_SCRIPT).toContain("Realized");
  });

  test("never touches Win32_Product and never shells out to wmic", () => {
    expect(HYPERV_GUESTS_SCRIPT).not.toContain("Win32_Product");
    expect(HYPERV_GUESTS_SCRIPT.toLowerCase()).not.toContain("wmic");
  });
});

// ── Gates and mappers (#1188: every host-parsed field is unknown) ─────────────────────────────────

describe("hypervGuid", () => {
  test("strips braces, lowercases, and validates the 8-4-4-4-12 shape", () => {
    expect(hypervGuid("{9F86D081-1234-4B10-8034-B4C04F524D33}")).toBe(
      "9f86d081-1234-4b10-8034-b4c04f524d33",
    );
    expect(hypervGuid("9F86D081-1234-4B10-8034-B4C04F524D33")).toBe(
      "9f86d081-1234-4b10-8034-b4c04f524d33",
    );
  });

  test("non-strings and non-GUIDs are undefined — a gate, not a coercion", () => {
    expect(hypervGuid(42)).toBeUndefined();
    expect(hypervGuid(null)).toBeUndefined();
    expect(hypervGuid("not-a-guid")).toBeUndefined();
    expect(hypervGuid("")).toBeUndefined();
  });
});

describe("parseHypervBlob", () => {
  test("one JSON object in, the document out; everything else is null", () => {
    expect(parseHypervBlob('{"vms":[]}')).toEqual({ vms: [] });
    expect(parseHypervBlob(null)).toBeNull();
    expect(parseHypervBlob("")).toBeNull();
    expect(parseHypervBlob("At line:1 char:1 ... is not recognized")).toBeNull();
    expect(parseHypervBlob("[1,2]")).toBeNull();
  });
});

describe("buildHypervGuests", () => {
  test("maps VMs with joined MACs and BIOSGUIDs — GUIDs normalized, MACs canonicalized", () => {
    const { warn, notes } = sink();
    expect(buildHypervGuests(blob(), warn)).toEqual([
      {
        ref: "9f86d081-1234-4b10-8034-b4c04f524d33",
        name: "dc01",
        kind: "hyperv",
        state: "running",
        // Hyper-V hands MACs over with NO separators; the wire spelling is canonical (#1169).
        macs: ["00:15:5d:0a:2b:01", "00:15:5d:0a:2b:02"],
        smbiosUuid: "11112222-3333-4444-5555-666677778888",
        cores: 4,
        memoryBytes: 4294967296,
      },
      {
        ref: "0a1b2c3d-5678-4e5f-9012-abcdef012345",
        name: "sql01",
        kind: "hyperv",
        state: "stopped",
        macs: ["00:15:5d:0a:2b:03"],
        smbiosUuid: "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000",
        cores: 8,
        // MemoryAssigned is 0 for a stopped VM — "not assigned" is omitted, never reported as 0.
      },
    ]);
    expect(notes).toEqual([]);
  });

  test("a SINGLE VM arriving as a bare object still maps — the ConvertTo-Json unwrap quirk", () => {
    const single = buildHypervGuests(
      {
        vms: { Id: "9F86D081-1234-4B10-8034-B4C04F524D33", Name: "solo", State: "Running" },
        nics: { Id: "9F86D081-1234-4B10-8034-B4C04F524D33", Mac: "00155D0A2B01" },
        bios: { Id: "9F86D081-1234-4B10-8034-B4C04F524D33", BiosGuid: "{11112222-3333-4444-5555-666677778888}" },
      },
      sink().warn,
    );
    expect(single).toHaveLength(1);
    expect(single?.[0]).toMatchObject({ name: "solo", macs: ["00:15:5d:0a:2b:01"] });
  });

  test("a VM with no usable VMId GUID is dropped and the drop is explained", () => {
    const { warn, notes } = sink();
    const guests = buildHypervGuests(
      blob({ vms: [{ Name: "ghost", State: "Running" }, { Id: 42, Name: "junk" }] }),
      warn,
    );
    expect(guests).toEqual([]);
    expect(notes.join(" ")).toContain("2");
  });

  test("state degrades honestly: Saved → suspended, Paused → paused, a 5.1 enum leak by number, junk → other", () => {
    const states = buildHypervGuests(
      blob({
        vms: [
          { Id: "11111111-1111-4111-8111-111111111111", Name: "a", State: "Saved" },
          { Id: "22222222-2222-4222-8222-222222222222", Name: "b", State: "Paused" },
          // ConvertTo-Json in 5.1 renders an un-stringified enum as its integer.
          { Id: "33333333-3333-4333-8333-333333333333", Name: "c", State: "2" },
          { Id: "44444444-4444-4444-8444-444444444444", Name: "d", State: "Starting" },
          { Id: "55555555-5555-4555-8555-555555555555", Name: "e" },
        ],
        nics: [],
        bios: [],
      }),
      sink().warn,
    );
    expect(states?.map((g) => g.state)).toEqual(["suspended", "paused", "running", "other", undefined]);
  });

  test("an empty VM list is an EMPTY guest list — Get-VM ran and this host runs none", () => {
    expect(buildHypervGuests(blob({ vms: [], nics: [], bios: [] }), sink().warn)).toEqual([]);
  });

  test("a null document is undefined — 'could not look' must not retire the server's children", () => {
    expect(buildHypervGuests(null, sink().warn)).toBeUndefined();
  });

  test("the script's own swallowed errors surface as warnings", () => {
    const { warn, notes } = sink();
    buildHypervGuests(blob({ errors: ["Get-VM: Access is denied.", 42, "  "] }), warn);
    expect(notes).toEqual(["hypervisor: Get-VM: Access is denied."]);
  });
});

// ── The orchestrator, with injected exec ──────────────────────────────────────────────────────────

describe("collectHypervisorWindows", () => {
  const HAPPY = JSON.stringify(blob());

  test("policy off: nothing spawned, one 'disabled by agent policy' warning", async () => {
    const { warn, notes } = sink();
    const spawned: string[][] = [];
    const out = await collectHypervisorWindows(
      warn,
      policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, hypervisor: false } }),
      true,
      "10.0.20348",
      async (args) => {
        spawned.push(args);
        return HAPPY;
      },
    );
    expect(out).toBeUndefined();
    expect(spawned).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("disabled by agent policy");
  });

  test("detection did not fire: silent nothing, and STILL nothing spawned", async () => {
    // This is the "non-Hyper-V hosts pay zero cost" property: the second interpreter start only
    // ever happens on a host whose facts sweep answered `hyperv: true`.
    const { warn, notes } = sink();
    const spawned: string[][] = [];
    const out = await collectHypervisorWindows(warn, AGENT_POLICY_DEFAULT, false, "10.0.20348", async (args) => {
      spawned.push(args);
      return HAPPY;
    });
    expect(out).toBeUndefined();
    expect(spawned).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("detection fired: one powershell start running the guests script, facet + guests out", async () => {
    const { warn, notes } = sink();
    const spawned: string[][] = [];
    const out = await collectHypervisorWindows(warn, AGENT_POLICY_DEFAULT, true, "10.0.20348", async (args) => {
      spawned.push(args);
      return HAPPY;
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[0]).toBe("powershell.exe");
    expect(spawned[0]?.at(-1)).toBe(HYPERV_GUESTS_SCRIPT);
    expect(out?.hypervisor).toEqual({ platform: "hyperv", version: "10.0.20348" });
    expect(out?.guests).toHaveLength(2);
    expect(notes).toEqual([]);
  });

  test("the sweep failing keeps the facet, omits guests, and warns — absent ≠ empty", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorWindows(warn, AGENT_POLICY_DEFAULT, true, undefined, async () => null);
    expect(out?.hypervisor).toEqual({ platform: "hyperv" });
    expect(out?.guests).toBeUndefined();
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("the collected shape survives the wire contract", () => {
  test("a report carrying the mapper's own output validates against AgentReportSchema", async () => {
    const out = await collectHypervisorWindows(
      sink().warn,
      AGENT_POLICY_DEFAULT,
      true,
      "10.0.20348",
      async () => JSON.stringify(blob()),
    );
    const parsed = AgentReportSchema.safeParse({
      agentVersion: "dev",
      reportingSource: "agent:0123456789ab",
      externalId: "0123456789abcdef",
      reportedAt: new Date().toISOString(),
      host: { hostname: "hv01", hypervisor: out?.hypervisor, guests: out?.guests },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.host.hypervisor).toEqual(out?.hypervisor);
      expect(parsed.data.host.guests).toEqual(out?.guests);
    }
  });
});
