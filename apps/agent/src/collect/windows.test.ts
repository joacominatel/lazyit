import { describe, expect, test } from "bun:test";
import { AGENT_POLICY_DEFAULT, type AgentPolicy } from "@lazyit/shared";
import {
  buildWindowsHost,
  collectContainers,
  parseDockerCliContainers,
  parseWindowsBlob,
  parseWindowsSoftware,
  WINDOWS_FACTS_SCRIPT,
  windowsChassis,
  windowsVirtualization,
  type WindowsFacts,
} from "./windows";

/**
 * Issue #1144 — the Windows collector. Every test here is a PURE mapper over a fixture, because the
 * only Windows host this repo can reach is the one an operator installs on: CI runs Linux and the
 * developer machines run macOS. That is a real limitation and it shapes the design rather than being
 * worked around — everything that reads WMI/CIM/the registry happens in ONE PowerShell call whose
 * output is a JSON document, and everything that turns that document into a report is testable here.
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
    expect(host.cpu).toEqual({ model: "13th Gen Intel(R) Core(TM) i7-1365U", cores: 10 });
    expect(host.memoryBytes).toBe(34_058_919_936);
    expect(host.domain).toEqual({ name: "corp.example.com", joined: true });
    expect(host.fqdn).toBe("lt-0042.corp.example.com");
    expect(host.bootedAt).toBe("2026-07-30T06:12:00.000Z");
    expect(privileged).toBe(true);
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
    expect(host.nics).toEqual([
      {
        name: "Ethernet",
        mac: "AA:BB:CC:DD:EE:01",
        isVirtual: false,
        ipv4: ["10.20.30.40"],
        ipv6: [
          { address: "fe80::1c2d:3e4f:5a6b:7c8d", prefixLength: 64, scope: "link" },
          { address: "2001:db8:1::5", prefixLength: 64, scope: "global" },
        ],
      },
      {
        name: "vEthernet (WSL)",
        mac: "AA:BB:CC:DD:EE:02",
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

describe("collectContainers (Windows)", () => {
  test("a host with no docker client reports NOTHING and warns about NOTHING", async () => {
    // Requirement from the issue, restated: the Linux collector is silent about a box that does not
    // run containers, and the Windows one must be too — otherwise every one of ~180 endpoints files a
    // warning per report until the operator learns to ignore the field.
    //
    // The lookup is by NAME on PATH and it happens on EVERY run, which is the whole answer to "if I
    // install Docker later, does it start reporting?": nothing is cached, so the first tick after
    // Docker appears finds it.
    const { warn, notes } = sink();
    const containers = await collectContainers(warn, "lazyit-nonexistent-docker-shim");
    expect(containers).toBeUndefined();
    expect(notes).toEqual([]);
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
});
