import { describe, expect, test } from "bun:test";
import { hostname as osHostname } from "node:os";
import { AGENT_POLICY_DEFAULT, type AgentPolicy } from "@lazyit/shared";
import {
  buildWindowsFactsScript,
  buildWindowsHost,
  collectContainers,
  collectHost,
  DEFAULT_PATHEXT,
  parseDockerCliContainers,
  parseWindowsBlob,
  parseWindowsSoftware,
  readMachineGuid,
  resetWindowsCollectorMemos,
  resolveDockerClient,
  WINDOWS_FACTS_SCRIPT,
  windowsChassis,
  windowsVirtualization,
  type WindowsFacts,
} from "./windows";

/**
 * Issue #1144 — the Windows collector. Almost every test here is a PURE mapper over a fixture, because
 * the only Windows host this repo can reach is the one an operator installs on: CI runs Linux and the
 * developer machines run macOS. That is a real limitation and it shapes the design rather than being
 * worked around — the whole WMI/CIM/registry sweep happens in ONE PowerShell call whose output is a
 * JSON document (the dedup key is a second, much smaller call; see `readMachineGuid`), and everything
 * that turns that document into a report is testable here.
 *
 * The two impure boundaries that are NOT pure mappers — the docker lookup and the PowerShell spawn —
 * take an injected lookup/exec below rather than going untested, because the one that was left
 * implicit is exactly the one that failed silently.
 *
 * What CANNOT be tested here is stated plainly rather than faked: whether the PowerShell script emits
 * the shape these fixtures describe. `WINDOWS_FACTS_SCRIPT` is asserted for the two things a mistake
 * would cost an estate (`Win32_Product`, `wmic.exe`) and for every class it must actually query, but
 * the round trip can only be seen by running `lazyit-agent show` on a real Windows host.
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

/** A representative domain-joined laptop, as the collector's PowerShell blob would describe it. */
function facts(patch: Partial<WindowsFacts> = {}): WindowsFacts {
  return {
    os: {
      Caption: "Microsoft Windows 11 Pro",
      Version: "10.0.26100",
      BuildNumber: "26100",
      LastBootUpTime: "2026-07-30T06:12:00.0000000Z",
    },
    cs: {
      TotalPhysicalMemory: 34_058_919_936,
      Manufacturer: "Dell Inc.",
      Model: "Latitude 7440",
      Domain: "corp.example.com",
      PartOfDomain: true,
      DNSHostName: "LT-0042",
    },
    cpu: [
      {
        Name: "13th Gen Intel(R) Core(TM) i7-1365U",
        NumberOfCores: 10,
        NumberOfLogicalProcessors: 12,
      },
    ],
    bios: { SerialNumber: "7QK4RM3" },
    csp: { UUID: "4C4C4544-0051-4B10-8034-B4C04F524D33" },
    enclosure: { ChassisTypes: [10] },
    disks: [
      { DeviceID: "\\\\.\\PHYSICALDRIVE0", Model: "KXG80ZNV1T02 NVMe", Size: 1_024_209_543_168 },
    ],
    physicalDisks: [],
    adapters: [
      { Index: 7, NetConnectionID: "Ethernet", MACAddress: "AA:BB:CC:DD:EE:01", PhysicalAdapter: true },
      { Index: 12, NetConnectionID: "vEthernet (WSL)", MACAddress: "AA:BB:CC:DD:EE:02", PhysicalAdapter: false },
    ],
    adapterConfigs: [
      {
        Index: 7,
        MACAddress: "AA:BB:CC:DD:EE:01",
        IPAddress: ["10.20.30.40", "fe80::1c2d:3e4f:5a6b:7c8d", "2001:db8:1::5"],
        IPSubnet: ["255.255.255.0", "64", "64"],
      },
      { Index: 12, MACAddress: "AA:BB:CC:DD:EE:02", IPAddress: ["172.28.0.1"], IPSubnet: ["255.255.240.0"] },
    ],
    software: [
      { DisplayName: "7-Zip 24.09 (x64)", DisplayVersion: "24.09", Publisher: "Igor Pavlov" },
    ],
    machineGuid: "f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8",
    elevated: true,
    ...patch,
  };
}

describe("parseWindowsBlob", () => {
  test("null in, null out — a PowerShell that could not run is not an empty host", () => {
    expect(parseWindowsBlob(null)).toBeNull();
  });

  test("a body that is not JSON is null, never a half-read host", () => {
    expect(parseWindowsBlob("powershell.exe : the term 'Get-CimInstance' is not recognized")).toBeNull();
  });

  test("a JSON array or scalar is refused — the blob is one object by construction", () => {
    expect(parseWindowsBlob("[1,2,3]")).toBeNull();
    expect(parseWindowsBlob('"nope"')).toBeNull();
  });
});

describe("buildWindowsHost", () => {
  test("stamps os.family windows unconditionally, even with no blob at all", () => {
    // The binary that runs this code IS the Windows build, so the family is known even when every
    // other fact failed. A report with no `os` block would be defaulted to `linux` by the contract's
    // own pre-v2 default, which would be a confidently WRONG platform on the fleet view.
    const { host } = buildWindowsHost(null, undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(host.os).toEqual({ family: "windows" });
    expect(host.hostname.length).toBeGreaterThan(0);
  });

  test("an absent blob reports UNPRIVILEGED rather than claiming elevation it never observed", () => {
    const { privileged } = buildWindowsHost(null, undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(privileged).toBe(false);
  });

  test("os carries name, version and BUILD — 'version 10' is useless to an operator", () => {
    const { host } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(host.os).toEqual({
      family: "windows",
      name: "Microsoft Windows 11 Pro",
      version: "10.0.26100",
      build: "26100",
    });
  });

  test("cpu, memory, domain, fqdn and bootedAt come off the same blob", () => {
    const { host, privileged } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
    // 12, not 10: `cores` is LOGICAL CPUs (#1191) — the fixture machine is 10c/12t.
    expect(host.cpu).toEqual({ model: "13th Gen Intel(R) Core(TM) i7-1365U", cores: 12 });
    expect(host.memoryBytes).toBe(34_058_919_936);
    expect(host.domain).toEqual({ name: "corp.example.com", joined: true });
    expect(host.fqdn).toBe("lt-0042.corp.example.com");
    expect(host.bootedAt).toBe("2026-07-30T06:12:00.000Z");
    expect(privileged).toBe(true);
  });

  // THE 2x FLEET SKEW THIS PINS (#1191). `host.cpu.cores` has exactly ONE wire semantic — LOGICAL
  // CPUs, which is what Linux has always shipped (`/proc/cpuinfo`'s `processor :` lines count
  // hyper-threads). The first Windows cut summed physical NumberOfCores instead, so the same 8c/16t
  // machine reported 8 or 16 depending on OS and every fleet-wide capacity comparison was silently
  // 2x off. Same class as #1169, different fact.
  test("cores are LOGICAL CPUs — the one wire semantic, the one Linux has always shipped (#1191)", () => {
    const { host } = buildWindowsHost(
      facts({
        cpu: [
          { Name: "Intel(R) Xeon(R) Silver 4210", NumberOfCores: 10, NumberOfLogicalProcessors: 20 },
          { Name: "Intel(R) Xeon(R) Silver 4210", NumberOfCores: 10, NumberOfLogicalProcessors: 20 },
        ],
      }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    // Summed across sockets, like the Linux count is.
    expect(host.cpu?.cores).toBe(40);
  });

  test("a CPU entry without NumberOfLogicalProcessors falls back to its physical count", () => {
    // Very old SKUs can omit the logical count; fewer-than-the-truth beats reporting nothing.
    const { host } = buildWindowsHost(
      facts({ cpu: [{ Name: "Old Xeon", NumberOfCores: 4 }] }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    expect(host.cpu?.cores).toBe(4);
  });

  // THE IDENTITY FLIP THIS PINS (#1191). The hostname used to prefer the sweep's DNSHostName and
  // fall back to os.hostname() (NetBIOS-style, typically uppercase) only when the sweep degraded —
  // so a transient WMI failure changed the reported name/case between consecutive reports of the
  // SAME node, and `fqdn` (lowercased) disagreed with `hostname` (verbatim) inside one report.
  describe("the hostname is one canonical lowercase value from the sweep-independent source (#1191)", () => {
    test("healthy sweep and degraded sweep answer the SAME hostname", () => {
      const healthy = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {}).host;
      const degraded = buildWindowsHost(null, undefined, AGENT_POLICY_DEFAULT, () => {}).host;
      expect(healthy.hostname).toBe(degraded.hostname);
      // The stable source is the OS's own answer, canonicalised once.
      expect(healthy.hostname).toBe(osHostname().toLowerCase());
    });

    test("hostname and fqdn cannot disagree in case within one report", () => {
      const { host } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
      expect(host.hostname).toBe(host.hostname.toLowerCase());
      expect(host.fqdn).toBe(host.fqdn?.toLowerCase());
    });
  });

  test("a workgroup machine reports NO domain — Win32_ComputerSystem.Domain is the workgroup name there", () => {
    const { host } = buildWindowsHost(
      facts({ cs: { ...facts().cs, PartOfDomain: false, Domain: "WORKGROUP" } }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    // `joined: false` is a POSITIVE finding and the fact an operator actually triages on — it is the
    // difference between "not in the directory" and "we never looked". Only the NAME is dropped,
    // because Win32_ComputerSystem.Domain holds the workgroup name there and shipping that as an AD
    // domain would be a confidently wrong answer.
    expect(host.domain).toEqual({ joined: false });
    // …and no fqdn either: `LT-0042.WORKGROUP` is not a name anything can resolve.
    expect(host.fqdn).toBeUndefined();
  });

  test("hardware is manufacturer/model/serial, and the serial feeds the identifier set", () => {
    const { host } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(host.hardware).toEqual({
      manufacturer: "Dell Inc.",
      model: "Latitude 7440",
      serial: "7QK4RM3",
    });
    expect(host.identifiers).toEqual([
      { kind: "windows-machine-guid", value: "f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8" },
      { kind: "smbios-uuid", value: "4c4c4544-0051-4b10-8034-b4c04f524d33" },
      { kind: "serial", value: "7QK4RM3" },
      { kind: "mac", value: "aa:bb:cc:dd:ee:01" },
    ]);
  });

  test("NICs join adapter to configuration by Index, carrying v4 AND v6 with a derived scope", () => {
    const { host } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
    // The MACs are LOWER-CASE here while the fixture (like WMI itself) spells them upper (#1169):
    // the wire form is one canonical spelling on both collectors. See collect.test.ts for the
    // cross-collector property this is the Windows half of.
    expect(host.nics).toEqual([
      {
        name: "Ethernet",
        mac: "aa:bb:cc:dd:ee:01",
        isVirtual: false,
        ipv4: ["10.20.30.40"],
        ipv6: [
          { address: "fe80::1c2d:3e4f:5a6b:7c8d", prefixLength: 64, scope: "link" },
          { address: "2001:db8:1::5", prefixLength: 64, scope: "global" },
        ],
      },
      {
        name: "vEthernet (WSL)",
        mac: "aa:bb:cc:dd:ee:02",
        isVirtual: true,
        ipv4: ["172.28.0.1"],
      },
    ]);
  });

  test("the primary MAC identifier is the contract's choice, not the adapter order", () => {
    // `selectPrimaryMac` prefers a PHYSICAL adapter; listing the Hyper-V vSwitch first must not
    // change which MAC #1141 corroborates on — that value has to be stable across reports.
    const base = facts();
    const flipped = facts({
      adapters: (base.adapters as unknown[]).slice().reverse(),
      adapterConfigs: (base.adapterConfigs as unknown[]).slice().reverse(),
    });
    const { host } = buildWindowsHost(flipped, undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(host.identifiers?.find((i) => i.kind === "mac")?.value).toBe("aa:bb:cc:dd:ee:01");
  });

  test("disks come from Win32_DiskDrive and carry NO mountpoint — a physical drive is not one", () => {
    const { host } = buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {});
    expect(host.disks).toEqual([
      { device: "\\\\.\\PHYSICALDRIVE0", sizeBytes: 1_024_209_543_168 },
    ]);
  });

  test("MSFT_PhysicalDisk is the FALLBACK when Win32_DiskDrive answers nothing", () => {
    // Storage Spaces and some paravirtual controllers leave Win32_DiskDrive empty while the Storage
    // namespace still enumerates the disks. Reporting nothing there would look identical to a host
    // with no disks at all.
    const { host } = buildWindowsHost(
      facts({
        disks: [],
        physicalDisks: [{ FriendlyName: "Msft Virtual Disk", Size: 137_438_953_472 }],
      }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    expect(host.disks).toEqual([{ device: "Msft Virtual Disk", sizeBytes: 137_438_953_472 }]);
  });

  test("containers are passed through verbatim, including the empty list", () => {
    // ABSENT and `[]` are different answers the server acts on differently (#1139): absent leaves the
    // stored child nodes alone, `[]` retires them.
    expect(buildWindowsHost(facts(), [], AGENT_POLICY_DEFAULT, () => {}).host.containers).toEqual([]);
    expect(
      buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, () => {}).host.containers,
    ).toBeUndefined();
  });

  test("the policy vetoes are honoured and each files a warning", () => {
    const { warn, notes } = sink();
    const { host } = buildWindowsHost(
      facts(),
      undefined,
      policy({
        collect: { ...AGENT_POLICY_DEFAULT.collect, hardware: false, nics: false, disks: false },
      }),
      warn,
    );
    expect(host.hardware).toBeUndefined();
    expect(host.nics).toBeUndefined();
    expect(host.disks).toBeUndefined();
    // hardware off also removes the SERIAL from the identifier set — same identity consequence the
    // Linux collector documents, and it must be true here too or the veto means something different
    // per platform.
    expect(host.identifiers?.some((i) => i.kind === "serial")).toBe(false);
    expect(notes).toHaveLength(3);
  });

  test("a non-string CIM string field is skipped, never fatal (#1188)", () => {
    // The same latent pattern as the Uninstall hive, on the CIM side: the document is parsed from a
    // host, so no field is guaranteed the type the class declares. Each poisoned field costs ITSELF
    // — the rest of the host block still ships.
    const base = facts();
    const { host } = buildWindowsHost(
      facts({
        os: { ...base.os, Caption: ["Microsoft", "Windows"] },
        cs: { ...base.cs, DNSHostName: 42, Manufacturer: { odd: true } },
        bios: { SerialNumber: 12345 },
        adapters: [
          { Index: 3, NetConnectionID: 7, MACAddress: "AA:BB:CC:DD:EE:09", PhysicalAdapter: true },
          ...(base.adapters as unknown[]),
        ],
        machineGuid: 99,
      }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    // The numeric DNSHostName is not the hostname — the OS fallback is.
    expect(host.hostname).not.toBe("42");
    expect(host.hostname.length).toBeGreaterThan(0);
    // Caption was an array: `name` is omitted, the sibling fields survive.
    expect(host.os).toEqual({ family: "windows", version: "10.0.26100", build: "26100" });
    // Manufacturer (object) and serial (number) are dropped; model still reports.
    expect(host.hardware).toEqual({ model: "Latitude 7440" });
    // The adapter whose NetConnectionID is a number is skipped; the well-formed ones survive.
    expect(host.nics?.map((n) => n.name)).toEqual(["Ethernet", "vEthernet (WSL)"]);
    // A numeric MachineGuid is no identifier at all, not a stringified one.
    const kinds = (host.identifiers ?? []).map((i) => i.kind);
    expect(kinds).not.toContain("windows-machine-guid");
    expect(kinds).not.toContain("serial");
    expect(kinds).toContain("smbios-uuid");
  });

  test("junk SMBIOS identity is dropped, not shipped consistently spelled", () => {
    const { host } = buildWindowsHost(
      facts({
        csp: { UUID: "03000200-0400-0500-0006-000700080009" },
        bios: { SerialNumber: "To be filled by O.E.M." },
      }),
      undefined,
      AGENT_POLICY_DEFAULT,
      () => {},
    );
    const kinds = (host.identifiers ?? []).map((i) => i.kind);
    expect(kinds).not.toContain("smbios-uuid");
    expect(kinds).not.toContain("serial");
    expect(kinds).toContain("windows-machine-guid");
  });

  // THE GAP THIS CLOSES. The sweep runs under `$ErrorActionPreference='SilentlyContinue'`, which is
  // exactly right — one class this SKU does not have must not abort the whole document — but it also
  // meant a per-fact failure produced a NULL key and NOTHING ELSE. Every Linux collector warns when
  // it degrades; the single Windows call warned only when the whole document failed to arrive. The
  // point of `diagnostics.warnings` (#1138) is that an empty column is explainable, so an operator
  // looking at a blank serial on a Windows host must be able to learn why, exactly as on Linux.
  describe("a per-fact failure inside the sweep is EXPLAINED, not silent", () => {
    test("an empty serial files a note naming the class and what it cost", () => {
      const { warn, notes } = sink();
      const { host } = buildWindowsHost(
        facts({ bios: { SerialNumber: null } }),
        undefined,
        AGENT_POLICY_DEFAULT,
        warn,
      );
      expect(host.hardware?.serial).toBeUndefined();
      expect(notes.some((n) => n.startsWith("hardware:") && n.includes("Win32_BIOS"))).toBe(true);
    });

    test("each empty fact group files its own note", () => {
      const { warn, notes } = sink();
      buildWindowsHost(
        facts({
          os: null,
          cs: null,
          cpu: [],
          bios: null,
          csp: null,
          enclosure: null,
          disks: [],
          physicalDisks: [],
          adapters: [],
          adapterConfigs: [],
          machineGuid: null,
        }),
        undefined,
        AGENT_POLICY_DEFAULT,
        warn,
      );
      for (const prefix of ["os:", "system:", "cpu:", "hardware:", "nics:", "disks:", "identity:"]) {
        expect(notes.some((n) => n.startsWith(prefix))).toBe(true);
      }
    });

    test("a healthy document files NOTHING — a warning per report would be noise", () => {
      const { warn, notes } = sink();
      buildWindowsHost(facts(), undefined, AGENT_POLICY_DEFAULT, warn);
      expect(notes).toEqual([]);
    });

    test("a policy-vetoed group is explained ONCE, by the policy note", () => {
      // Otherwise turning NICs off would file both "disabled by agent policy" and "enumerated
      // nothing", and the second is not true — nothing was asked for.
      const { warn, notes } = sink();
      buildWindowsHost(
        facts({ adapters: [], adapterConfigs: [], disks: [], physicalDisks: [], bios: null }),
        undefined,
        policy({
          collect: { ...AGENT_POLICY_DEFAULT.collect, hardware: false, nics: false, disks: false },
        }),
        warn,
      );
      expect(notes.filter((n) => n.startsWith("nics:"))).toHaveLength(1);
      expect(notes.filter((n) => n.startsWith("disks:"))).toHaveLength(1);
      expect(notes.filter((n) => n.startsWith("hardware:"))).toHaveLength(1);
      for (const note of notes) expect(note).toContain("disabled by agent policy");
    });

    test("the script's OWN error text is passed through — that is the 'why'", () => {
      // `$ErrorActionPreference='SilentlyContinue'` still records what failed in `$Error`; the script
      // now ships it, so "Access is denied" or "Invalid namespace" reaches the operator verbatim
      // instead of being a null key.
      const { warn, notes } = sink();
      buildWindowsHost(
        facts({ errors: ["Get-CimInstance: Access is denied.", "  ", 7] }),
        undefined,
        AGENT_POLICY_DEFAULT,
        warn,
      );
      expect(notes).toContain("windows: Get-CimInstance: Access is denied.");
      // Blank and non-string entries are dropped rather than shipped as empty warnings.
      expect(notes).toHaveLength(1);
    });

    test("an absent document files the ONE big note, not nine small ones", () => {
      // `collectHost` already says the whole sweep failed. Repeating it per fact group would bury it.
      const { warn, notes } = sink();
      buildWindowsHost(null, undefined, AGENT_POLICY_DEFAULT, warn);
      expect(notes).toEqual([]);
    });
  });
});

describe("windowsVirtualization", () => {
  test("recognises the hypervisor signatures a guest advertises in SMBIOS", () => {
    expect(windowsVirtualization("VMware, Inc.", "VMware20,1")).toBe("vmware");
    expect(windowsVirtualization("Microsoft Corporation", "Virtual Machine")).toBe("hyperv");
    expect(windowsVirtualization("QEMU", "Standard PC (Q35 + ICH9, 2009)")).toBe("kvm");
    expect(windowsVirtualization("Xen", "HVM domU")).toBe("xen");
    expect(windowsVirtualization("innotek GmbH", "VirtualBox")).toBe("other");
    expect(windowsVirtualization("Amazon EC2", "t3.medium")).toBe("other");
  });

  test("a real OEM board yields UNDEFINED, never a bare-metal claim", () => {
    // Same rule as Linux: `none` is a POSITIVE finding and this collector has no probe that can make
    // it. What it has is the absence of a hypervisor signature, which is weaker — so it says nothing
    // rather than asserting bare metal on an OEM string it does not fully control.
    expect(windowsVirtualization("Dell Inc.", "Latitude 7440")).toBeUndefined();
    expect(windowsVirtualization(undefined, undefined)).toBeUndefined();
  });

  test("Microsoft Corporation alone is not Hyper-V — Surface hardware ships that manufacturer", () => {
    expect(windowsVirtualization("Microsoft Corporation", "Surface Laptop 5")).toBeUndefined();
  });
});

describe("windowsChassis", () => {
  test("a detected hypervisor wins over the enclosure code", () => {
    expect(windowsChassis("vmware", [3])).toBe("vm");
  });

  test("with no hypervisor signature the enclosure code still classifies the host", () => {
    // This is the one place the Windows rule deliberately DIFFERS from `chassisFor`: on Linux an
    // absent virtualization probe forces `unknown`, because inside a container /sys/class/dmi is the
    // HOST's board. A Windows agent installed by install.ps1 runs on the machine whose enclosure it
    // is reading, so throwing the fact away would cost every physical Windows host its chassis —
    // and laptop-vs-desktop is exactly what #1139 needs on an estate of 180 endpoints.
    expect(windowsChassis(undefined, [10])).toBe("laptop");
    expect(windowsChassis(undefined, [3])).toBe("desktop");
    expect(windowsChassis(undefined, [23])).toBe("server");
  });

  test("an unmapped or missing enclosure code is unknown, never a guess", () => {
    expect(windowsChassis(undefined, [1])).toBe("unknown"); // "Other"
    expect(windowsChassis(undefined, [])).toBe("unknown");
    expect(windowsChassis(undefined, undefined)).toBe("unknown");
  });
});

describe("parseWindowsSoftware", () => {
  test("keeps named entries from BOTH hives and stamps source=registry", () => {
    // `Publisher` is READ off the registry and deliberately DROPPED: `software[]` in the contract is
    // `{ name, version, source }` and nothing else, and inventing a field the schema would silently
    // strip is how a collector starts disagreeing with the server about what it sent.
    const pkgs = parseWindowsSoftware([
      { DisplayName: "7-Zip 24.09 (x64)", DisplayVersion: "24.09", Publisher: "Igor Pavlov" },
      { DisplayName: "Notepad++ (32-bit x86)", DisplayVersion: "8.7.1" },
    ]);
    expect(pkgs).toEqual([
      { name: "7-Zip 24.09 (x64)", version: "24.09", source: "registry" },
      { name: "Notepad++ (32-bit x86)", version: "8.7.1", source: "registry" },
    ]);
  });

  test("drops entries with no DisplayName and entries flagged SystemComponent", () => {
    // These two filters are the difference between an inventory an operator reads and 900 rows of
    // Visual C++ runtime fragments and update stubs.
    const pkgs = parseWindowsSoftware([
      { DisplayVersion: "1.0" },
      { DisplayName: "   " },
      { DisplayName: "Windows Update Stub", SystemComponent: 1 },
      { DisplayName: "Real App", SystemComponent: 0 },
    ]);
    expect(pkgs).toEqual([{ name: "Real App", source: "registry" }]);
  });

  test("de-duplicates the same product listed in both the 64- and 32-bit hives", () => {
    const pkgs = parseWindowsSoftware([
      { DisplayName: "Google Chrome", DisplayVersion: "141.0.1" },
      { DisplayName: "Google Chrome", DisplayVersion: "141.0.1" },
      { DisplayName: "Google Chrome", DisplayVersion: "140.0.9" },
    ]);
    expect(pkgs).toEqual([
      { name: "Google Chrome", version: "141.0.1", source: "registry" },
      { name: "Google Chrome", version: "140.0.9", source: "registry" },
    ]);
  });

  test("a bare object (a one-element collection that did not survive as an array) is still one package", () => {
    expect(parseWindowsSoftware({ DisplayName: "Only App" })).toEqual([
      { name: "Only App", source: "registry" },
    ]);
    expect(parseWindowsSoftware(undefined)).toEqual([]);
  });

  // Issue #1188. The Uninstall hive is written by arbitrary third-party installers and its values
  // are NOT guaranteed strings: a DisplayVersion written as REG_DWORD arrives through ConvertTo-Json
  // as a number, a REG_MULTI_SZ DisplayName as an array. One such entry used to throw out of
  // `.trim()` and reject the WHOLE report — every tick, until that software was uninstalled.
  describe("a non-string registry value never fails the report (#1188)", () => {
    test("a REG_DWORD DisplayVersion (a number) is coerced — a number IS a meaningful version", () => {
      expect(
        parseWindowsSoftware([
          { DisplayName: "Vendor Runtime", DisplayVersion: 5 },
          { DisplayName: "Real App", DisplayVersion: "1.2.3" },
        ]),
      ).toEqual([
        { name: "Vendor Runtime", version: "5", source: "registry" },
        { name: "Real App", version: "1.2.3", source: "registry" },
      ]);
    });

    test("a REG_MULTI_SZ DisplayName (an array) costs THAT entry, with a warning — the rest ship", () => {
      const { warn, notes } = sink();
      const pkgs = parseWindowsSoftware(
        [
          { DisplayName: ["Broken", "Installer"], DisplayVersion: "9.9" },
          { DisplayName: "Real App", DisplayVersion: "1.0" },
        ],
        warn,
      );
      expect(pkgs).toEqual([{ name: "Real App", version: "1.0", source: "registry" }]);
      // The skip is EXPLAINED (#1138): an entry an operator can see in Programs and Features that
      // never reaches the inventory must leave a trace in diagnostics.warnings.
      expect(notes.some((n) => n.startsWith("software:") && n.includes("DisplayName"))).toBe(true);
      expect(notes).toHaveLength(1);
    });

    test("a missing or blank DisplayName still skips SILENTLY — fragments are normal, not junk", () => {
      const { warn, notes } = sink();
      parseWindowsSoftware([{ DisplayVersion: "1.0" }, { DisplayName: "   " }], warn);
      expect(notes).toEqual([]);
    });

    test("a DisplayVersion that is neither string nor number costs the FIELD, not the entry", () => {
      expect(parseWindowsSoftware([{ DisplayName: "Odd App", DisplayVersion: ["1", "0"] }])).toEqual([
        { name: "Odd App", source: "registry" },
      ]);
    });
  });
});

describe("parseDockerCliContainers", () => {
  test("null in, undefined out — 'we could not look' is not 'this host runs none'", () => {
    expect(parseDockerCliContainers(null)).toBeUndefined();
  });

  test("empty output is an EMPTY LIST — the probe ran and the host runs nothing", () => {
    expect(parseDockerCliContainers("")).toEqual([]);
    expect(parseDockerCliContainers("\n  \n")).toEqual([]);
  });

  test("maps the CLI's line-JSON onto the same shape the API path produces", () => {
    const out = [
      JSON.stringify({
        ID: "9f2c1a0b3d4e",
        Names: "web",
        Image: "nginx:1.27",
        State: "running",
        Ports: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp",
      }),
      JSON.stringify({ ID: "aa11bb22cc33", Names: "db,db-legacy", Image: "postgres:18", State: "running", Ports: "" }),
    ].join("\n");
    expect(parseDockerCliContainers(out)).toEqual([
      {
        name: "web",
        id: "9f2c1a0b3d4e",
        image: "nginx:1.27",
        state: "running",
        ports: [
          { containerPort: 80, hostPort: 8080, hostIp: "0.0.0.0", protocol: "tcp" },
          { containerPort: 80, hostPort: 8080, hostIp: "::", protocol: "tcp" },
          { containerPort: 443, protocol: "tcp" },
        ],
      },
      { name: "db", id: "aa11bb22cc33", image: "postgres:18", state: "running" },
    ]);
  });

  test("a malformed line is dropped, never fatal — the other containers still report", () => {
    const out = ['{"ID":"1","Names":"a"', JSON.stringify({ ID: "2", Names: "b" })].join("\n");
    expect(parseDockerCliContainers(out)).toEqual([{ name: "b", id: "2" }]);
  });

  test("an unrecognised state degrades to unknown rather than costing the container", () => {
    expect(
      parseDockerCliContainers(JSON.stringify({ Names: "x", State: "hibernating" })),
    ).toEqual([{ name: "x", state: "unknown" }]);
  });
});

/**
 * The `docker` LOOKUP is the same class of unverified Windows impure boundary this collector refused
 * to take for the named pipe, so it gets the same treatment: nothing here relies on `Bun.which`
 * guessing that a bare `docker` means `docker.exe`.
 *
 * Windows has no execute bit and no extensionless executables — a name on PATH resolves through
 * PATHEXT. `Bun.which("docker")` doing that on Windows is undocumented and this repo cannot check it,
 * and the cost of being wrong was SILENT BY DESIGN: a host running Docker Desktop would report no
 * containers, for ever, with nothing in `diagnostics.warnings` to say why. So the extensions are
 * tried explicitly here, and the resolved ABSOLUTE PATH is what gets spawned — which also takes
 * `Bun.spawn`'s own PATH resolution out of the picture.
 */
describe("resolveDockerClient", () => {
  test("finds docker.exe when the bare name does not resolve — Windows needs the extension", () => {
    const which = (name: string) =>
      name === "docker.exe" ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" : null;
    expect(resolveDockerClient("docker", which, DEFAULT_PATHEXT)).toBe(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    );
  });

  test("walks the host's own PATHEXT, in its order", () => {
    // A `docker.cmd` shim is what some Windows installs actually put on PATH.
    const tried: string[] = [];
    const which = (name: string) => {
      tried.push(name);
      return name === "docker.cmd" ? "C:\\tools\\docker.cmd" : null;
    };
    expect(resolveDockerClient("docker", which, ".COM;.EXE;.BAT;.CMD")).toBe("C:\\tools\\docker.cmd");
    // It stops at the first hit, so the bare name is never reached here — the extensions are walked
    // in PATHEXT's own order, which is what decides WHICH of two shims on PATH wins.
    expect(tried).toEqual(["docker.com", "docker.exe", "docker.bat", "docker.cmd"]);
  });

  test("the bare name is the LAST resort, after every extension has missed", () => {
    const tried: string[] = [];
    const which = (name: string) => {
      tried.push(name);
      return name === "docker" ? "/usr/bin/docker" : null;
    };
    expect(resolveDockerClient("docker", which, ".COM;.EXE")).toBe("/usr/bin/docker");
    expect(tried).toEqual(["docker.com", "docker.exe", "docker"]);
  });

  test("falls back to the built-in extension list when the host exports no PATHEXT", () => {
    const which = (name: string) => (name === "docker.exe" ? "C:\\d\\docker.exe" : null);
    expect(resolveDockerClient("docker", which, undefined)).toBe("C:\\d\\docker.exe");
  });

  test("a name that already carries an extension is looked up as written", () => {
    const tried: string[] = [];
    const which = (name: string) => {
      tried.push(name);
      return "C:\\d\\docker.exe";
    };
    expect(resolveDockerClient("docker.exe", which, DEFAULT_PATHEXT)).toBe("C:\\d\\docker.exe");
    expect(tried).toEqual(["docker.exe"]);
  });

  test("nothing on PATH under any extension is null — the host simply has no Docker", () => {
    expect(resolveDockerClient("docker", () => null, DEFAULT_PATHEXT)).toBeNull();
  });
});

describe("collectContainers (Windows)", () => {
  test("a host with no docker client reports NOTHING and warns about NOTHING", async () => {
    // Requirement from the issue, restated: the Linux collector is silent about a box that does not
    // run containers, and the Windows one must be too — otherwise every one of ~180 endpoints files a
    // warning per report until the operator learns to ignore the field.
    //
    // The lookup happens on EVERY run and caches nothing, which is the whole answer to "if I install
    // Docker later, does it start reporting?": the first tick after Docker appears finds it.
    const { warn, notes } = sink();
    const containers = await collectContainers(warn, "lazyit-nonexistent-docker-shim");
    expect(containers).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("spawns the RESOLVED PATH the lookup returned, not the bare name", async () => {
    const spawned: string[][] = [];
    const exec = async (args: string[]) => {
      spawned.push(args);
      return "";
    };
    await collectContainers(
      sink().warn,
      "docker",
      (name) => (name === "docker.exe" ? "C:\\d\\docker.exe" : null),
      DEFAULT_PATHEXT,
      exec,
    );
    expect(spawned).toEqual([["C:\\d\\docker.exe", "ps", "--format", "{{json .}}"]]);
  });

  test("a client that IS there but cannot answer is VISIBLE in diagnostics.warnings", async () => {
    // The failure this must never have again is the silent one. A resolved client that returns
    // nothing — engine stopped, Desktop not running because nobody is logged in, the pipe ACL
    // refusing SYSTEM — is exactly the "why is this host's container list empty?" question
    // `diagnostics.warnings` exists to answer, so it says so and names the path it tried.
    const { warn, notes } = sink();
    const containers = await collectContainers(
      warn,
      "docker",
      () => "C:\\d\\docker.exe",
      DEFAULT_PATHEXT,
      async () => null,
    );
    expect(containers).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("C:\\d\\docker.exe");
    expect(notes[0]).toContain("containers:");
  });

  test("the run's own degradation notes reach the report too", async () => {
    // `run` files a note for a missing/unpermitted binary and for a timeout. Those used to be
    // swallowed into a local flag, so a docker client that timed out looked identical to a host with
    // no Docker at all.
    const { warn, notes } = sink();
    await collectContainers(
      warn,
      "docker",
      () => "C:\\d\\docker.exe",
      DEFAULT_PATHEXT,
      async (_args, _timeout, runWarn) => {
        runWarn?.("docker: timed out after 60000ms — fact omitted");
        return null;
      },
    );
    expect(notes.some((n) => n.includes("timed out"))).toBe(true);
  });
});

describe("readMachineGuid", () => {
  test("ONE PowerShell call per process, however often the run asks for the dedup key", async () => {
    // `index.ts` asks twice on a reporting tick — once for the cadence jitter key before the due
    // gate, once inside `buildReport` — and once on a tick that reports nothing. Un-memoized, that
    // was an extra `powershell.exe` start per tick on every Windows host in the estate, including
    // the ~11 out of 12 ticks that do nothing at all.
    resetWindowsCollectorMemos();
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return "f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8\r\n";
    };
    expect(await readMachineGuid(() => {}, exec)).toBe("f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8");
    expect(await readMachineGuid(() => {}, exec)).toBe("f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8");
    expect(calls).toBe(1);
  });

  test("an unreadable registry value is null, never an empty-string dedup key", async () => {
    resetWindowsCollectorMemos();
    expect(await readMachineGuid(() => {}, async () => null)).toBeNull();
    resetWindowsCollectorMemos();
    expect(await readMachineGuid(() => {}, async () => "   \r\n")).toBeNull();
    resetWindowsCollectorMemos();
  });
});

/**
 * Issue #1177 — a collector switched OFF in policy still RAN on Windows. The single fixed PowerShell
 * blob queried `Win32_DiskDrive`, `MSFT_PhysicalDisk`, `Win32_NetworkAdapter`,
 * `Win32_NetworkAdapterConfiguration`, `Win32_BIOS` and both Uninstall hives unconditionally, and the
 * policy filters then declined to COPY the results into the report. Linux has always genuinely
 * skipped the work (`policy.collect.hardware ? collectHardware(warn) : undefined` — `dmidecode` is
 * never spawned), so the same toggle meant two different things per platform:
 *
 *  - "do not REPORT this to lazyit" — worked on both;
 *  - "do not READ this on my host" — worked on Linux, silently failed on Windows.
 *
 * The second is the one a security-minded operator is exercising, and it is what ADR-0074 §7's
 * `local may VETO, never widen` posture is built on. The fix composes the script from the collectors
 * the policy actually wants, which keeps the one-interpreter-start design (#1144) intact — it is a
 * string-building change, not an architectural one.
 */
describe("a collector the policy turns OFF is never RUN, not merely filtered (#1177)", () => {
  /** The policy with exactly one collector switched off. */
  const off = (key: keyof AgentPolicy["collect"]): AgentPolicy =>
    policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, [key]: false } });

  /** Every collector off — the operator who wants the agent to read as little as possible. */
  const ALL_OFF = policy({
    collect: {
      hardware: false,
      disks: false,
      nics: false,
      software: false,
      containers: false,
    },
  });

  test("collect.disks=false: neither disk class is in the script the host would run", () => {
    const script = buildWindowsFactsScript(off("disks"));
    expect(script).not.toContain("Win32_DiskDrive");
    expect(script).not.toContain("MSFT_PhysicalDisk");
    // …and the default still asks for them, so this is a policy effect and not a deletion.
    expect(buildWindowsFactsScript(AGENT_POLICY_DEFAULT)).toContain("Win32_DiskDrive");
  });

  test("collect.nics=false: neither adapter class is queried", () => {
    const script = buildWindowsFactsScript(off("nics"));
    expect(script).not.toContain("Win32_NetworkAdapter");
    expect(script).not.toContain("Win32_NetworkAdapterConfiguration");
    expect(buildWindowsFactsScript(AGENT_POLICY_DEFAULT)).toContain("Win32_NetworkAdapter");
  });

  test("collect.hardware=false: the BIOS serial is never READ, not read and then dropped", () => {
    // The sharpest case in the issue: an operator who turns hardware off believing the agent never
    // asks for the BIOS serial was wrong — it asked, held the value in memory, and discarded it.
    const script = buildWindowsFactsScript(off("hardware"));
    expect(script).not.toContain("Win32_BIOS");
    expect(buildWindowsFactsScript(AGENT_POLICY_DEFAULT)).toContain("Win32_BIOS");
  });

  test("collect.software=false: neither Uninstall hive is walked", () => {
    const script = buildWindowsFactsScript(off("software"));
    expect(script).not.toContain("Uninstall");
    expect(buildWindowsFactsScript(AGENT_POLICY_DEFAULT)).toContain("Uninstall");
  });

  test("what the report still needs survives every veto — this is a veto, not an off switch", () => {
    // `Win32_ComputerSystem` is NOT gated by `hardware`: memory, domain membership and the
    // virtualization signature all come off it, and none of those is the hardware collector's fact.
    // Identity (MachineGuid, the SMBIOS UUID) and the chassis code are likewise not policy-gated —
    // no policy flag names them, and inventing one here would be widening the toggle's meaning.
    const script = buildWindowsFactsScript(ALL_OFF);
    for (const kept of [
      "Win32_OperatingSystem",
      "Win32_ComputerSystem",
      "Win32_Processor",
      "Win32_ComputerSystemProduct",
      "Win32_SystemEnclosure",
      "MachineGuid",
    ]) {
      expect(script).toContain(kept);
    }
  });

  test("the argv the collector SPAWNS carries no query for a disabled collector", async () => {
    // The property the issue is actually about, asserted where it is true or false: not "the field is
    // absent from the report" (it always was) but "the work never reached the host".
    resetWindowsCollectorMemos();
    const spawned: string[][] = [];
    const exec = async (args: string[]) => {
      spawned.push(args);
      return null;
    };
    await collectHost(() => {}, ALL_OFF, exec);
    // ONE spawn: the fact sweep. No docker probe, because containers are off too.
    expect(spawned).toHaveLength(1);
    const commandLine = spawned[0]!.join(" ");
    for (const cls of [
      "Win32_DiskDrive",
      "MSFT_PhysicalDisk",
      "Win32_NetworkAdapter",
      "Win32_BIOS",
      "Uninstall",
    ]) {
      expect(commandLine).not.toContain(cls);
    }
    resetWindowsCollectorMemos();
  });

  test("a document with those sections MISSING still produces a valid report, and says why", () => {
    // Degrade-never-reject: an omitted section must read as "not collected", never as an error or an
    // empty host. Each veto still files its ONE note, so the empty column is answerable — which is
    // the property that makes a disabled collector read identically on both platforms.
    const { warn, notes } = sink();
    const { host } = buildWindowsHost(
      // What the composed script emits when every optional section is vetoed.
      {
        os: { Caption: "Microsoft Windows Server 2022 Standard", Version: "10.0.20348" },
        cs: { TotalPhysicalMemory: 68_719_476_736, Manufacturer: "Dell Inc.", Model: "PowerEdge R650", PartOfDomain: false },
        cpu: [{ Name: "Intel(R) Xeon(R) Silver 4310", NumberOfLogicalProcessors: 24 }],
        csp: { UUID: "4c4c4544-0051-4b10-8034-b4c04f524d33" },
        enclosure: { ChassisTypes: [23] },
        machineGuid: "f3b1a2c4-5d6e-4f70-8192-a3b4c5d6e7f8",
        elevated: true,
      },
      undefined,
      ALL_OFF,
      warn,
    );
    expect(host.os?.family).toBe("windows");
    expect(host.memoryBytes).toBe(68_719_476_736);
    expect(host.chassis).toBe("server");
    expect(host.nics).toBeUndefined();
    expect(host.disks).toBeUndefined();
    expect(host.hardware).toBeUndefined();
    // Identity is intact: the veto costs facts, never the host's ability to be recognised.
    expect(host.identifiers?.map((one) => one.kind)).toEqual(["windows-machine-guid", "smbios-uuid"]);
    const said = notes.join("\n");
    // `containers` is not among these: its veto is filed by `collectHost`, which is where the probe
    // it stops actually lives.
    for (const fact of ["hardware", "nics", "disks"]) {
      expect(said).toContain(`${fact}: disabled by agent policy`);
    }
    // …and no note claims a class "returned nothing" when nothing was asked for.
    expect(said).not.toContain("returned nothing");
    expect(said).not.toContain("enumerated nothing");
  });

  test("every policy variant keeps the script's own invariants — quoting, ASCII, errors LAST", () => {
    // The properties #1144/#1191 pinned over the fixed string have to hold over every string the
    // composer can produce, or the composition would be a new way to break them.
    const variants: AgentPolicy[] = [
      AGENT_POLICY_DEFAULT,
      ALL_OFF,
      off("hardware"),
      off("disks"),
      off("nics"),
      off("software"),
    ];
    for (const variant of variants) {
      const script = buildWindowsFactsScript(variant);
      expect(script).not.toContain('"');
      expect([...script].filter((c) => (c.codePointAt(0) ?? 0) > 0x7f)).toEqual([]);
      expect(script).toContain("elevated=$el;errors=@($Error|");
      // `errors` is the LAST key however many sections were dropped — a hashtable literal is
      // evaluated in written order, which is the only reason it sees what the earlier keys raised.
      expect(script.indexOf("errors=@($Error|")).toBeGreaterThan(script.indexOf("machineGuid=$mg"));
      expect(script.endsWith("}|ConvertTo-Json -Compress -Depth 4")).toBe(true);
      // No empty key and no doubled separator, whichever sections the policy removed.
      expect(script).not.toContain(";;");
      expect(script).not.toContain("@{;");
    }
  });
});

describe("WINDOWS_FACTS_SCRIPT", () => {
  test("never touches Win32_Product — enumerating it reconfigures every installed MSI", () => {
    expect(WINDOWS_FACTS_SCRIPT).not.toContain("Win32_Product");
  });

  test("never shells out to wmic.exe — deprecated, and removed in 24H2 / Server 2025", () => {
    expect(WINDOWS_FACTS_SCRIPT.toLowerCase()).not.toContain("wmic");
  });

  test("reads BOTH uninstall hives — half the inventory lives in WOW6432Node", () => {
    expect(WINDOWS_FACTS_SCRIPT).toContain(
      "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    );
    expect(WINDOWS_FACTS_SCRIPT).toContain(
      "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    );
  });

  test("queries every class the report has a home for", () => {
    for (const cls of [
      "Win32_OperatingSystem",
      "Win32_ComputerSystem",
      "Win32_Processor",
      "Win32_DiskDrive",
      "MSFT_PhysicalDisk",
      "Win32_NetworkAdapterConfiguration",
      "Win32_NetworkAdapter",
      "Win32_BIOS",
      "Win32_ComputerSystemProduct",
      "Win32_SystemEnclosure",
    ]) {
      expect(WINDOWS_FACTS_SCRIPT).toContain(cls);
    }
  });

  test("emits one compressed JSON document", () => {
    expect(WINDOWS_FACTS_SCRIPT).toContain("ConvertTo-Json -Compress -Depth 4");
  });

  test("SilentlyContinue still REPORTS: the sweep ships its own $Error text", () => {
    // The whole point of `$ErrorActionPreference='SilentlyContinue'` is that one missing class does
    // not abort the document — but the errors it swallows are still what answers "why is this column
    // empty?". `$Error` is cleared first so nothing from before the sweep can land in the report, and
    // the key is emitted LAST because a hashtable literal is evaluated in written order, which is the
    // only reason it sees the errors the earlier keys raised.
    expect(WINDOWS_FACTS_SCRIPT).toContain("$Error.Clear()");
    // Anchored on the key BEFORE it, so a renamed or detached key cannot satisfy this by substring.
    expect(WINDOWS_FACTS_SCRIPT).toContain("elevated=$el;errors=@($Error|");
    // …and it is the last key in the literal, which is the only reason it sees what the earlier ones
    // raised. `software=@(` is the last CIM/registry read before it.
    expect(WINDOWS_FACTS_SCRIPT.indexOf("errors=@($Error|")).toBeGreaterThan(
      WINDOWS_FACTS_SCRIPT.indexOf("software=@("),
    );
    // Bounded: a pathological host must not turn the report into an error log.
    expect(WINDOWS_FACTS_SCRIPT).toContain("Select-Object -First 10");
  });

  test("every string in it is SINGLE-quoted — Windows has no argv", () => {
    // A double quote anywhere would put the whole collector at the mercy of the command-line
    // re-quoting round trip. Re-asserted here because the error-reporting addition writes strings too.
    expect(WINDOWS_FACTS_SCRIPT).not.toContain('"');
  });

  // THE LATENT MOJIBAKE THIS PINS (#1191). Windows PowerShell 5.1 writes redirected stdout in the
  // OEM code page while `run()` decodes UTF-8. That was safe only because 5.1's ConvertTo-Json
  // escapes non-ASCII to \uXXXX — an undocumented dependency: a switch to pwsh or one raw string
  // fact would mojibake every localized name, break LAZYIT_EXCLUDE_NICS globs and churn
  // softwareHash. The script states the boundary's encoding itself instead of leaning on that.
  test("stdout is declared UTF-8 (no BOM) at the top, before anything is emitted (#1191)", () => {
    const encoding = "try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false}catch{}";
    expect(WINDOWS_FACTS_SCRIPT).toContain(encoding);
    // BEFORE `$Error.Clear()`, so a host that refuses the setter (no console handle) cannot leak
    // that caught error into the report's errors[] — and long before the one emit at the end.
    expect(WINDOWS_FACTS_SCRIPT.indexOf(encoding)).toBeLessThan(
      WINDOWS_FACTS_SCRIPT.indexOf("$Error.Clear()"),
    );
  });

  test("the script itself stays pure ASCII — it travels as one command-line argument", () => {
    // The same rule installers-encoding.test.ts holds over the public installers, held here over the
    // one PowerShell string this binary carries: a non-ASCII byte would be at the mercy of the
    // child's ANSI/OEM decode exactly like a BOM-less .ps1 (#1166).
    const offenders = [...WINDOWS_FACTS_SCRIPT].filter((c) => (c.codePointAt(0) ?? 0) > 0x7f);
    expect(offenders).toEqual([]);
  });
});
