import { describe, expect, test } from "bun:test";
import { AGENT_POLICY_DEFAULT, AgentReportSchema, type AgentPolicy } from "@lazyit/shared";
import {
  collectHypervisorLinux,
  isPveFuseMounted,
  LIBVIRT_SOCKETS,
  parsePveClusterName,
  parsePveConfig,
  parsePveGuestList,
  parsePveVersion,
  parseVirshDomainXml,
  parseVirshNameList,
  pveNodeName,
  type LinuxHypervisorDeps,
} from "./hypervisor-linux";

/**
 * ADR-0095 (#1217) — the Linux hypervisor collector. Like every collector in this repo, the impure
 * boundary is injectable and everything that turns a platform's answer into the wire shape is a pure
 * parser over a captured fixture: no test here needs a Proxmox node, a libvirt daemon or an XCP-ng
 * dom0, because CI has none of them.
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

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

/** `/proc/mounts` on a live PVE node — pmxcfs mounts `/etc/pve` as a fuse filesystem. */
const PVE_MOUNTS = [
  "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
  "/dev/mapper/pve-root / ext4 rw,relatime,errors=remount-ro 0 0",
  "/dev/fuse /etc/pve fuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other 0 0",
  "tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime 0 0",
].join("\n");

/** The same file on an ordinary Debian box — `/etc/pve` may even EXIST as a leftover dir. */
const PLAIN_MOUNTS = [
  "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
  "/dev/sda1 / ext4 rw,relatime 0 0",
].join("\n");

const QEMU_LIST = JSON.stringify([
  { vmid: 101, name: "web01", status: "running", maxmem: 4294967296, cpus: 2 },
  { vmid: 102, name: "db01", status: "stopped", maxmem: 8589934592 },
]);

const LXC_LIST = JSON.stringify([
  { vmid: 200, name: "ct-dns", status: "running", maxmem: 536870912 },
]);

const QEMU_CONFIG_101 = JSON.stringify({
  smbios1: "uuid=D0F2C3A4-1B2C-4D5E-8F90-112233445566",
  net0: "virtio=BC:24:11:2A:3B:4C,bridge=vmbr0,firewall=1",
  net1: "e1000=BC:24:11:2A:3B:4D,bridge=vmbr1",
  cores: 2,
  ostype: "l26",
  memory: 4096,
});

const LXC_CONFIG_200 = JSON.stringify({
  hostname: "ct-dns",
  net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth",
  cores: 1,
  ostype: "debian",
});

const CLUSTER_STATUS = JSON.stringify([
  { type: "cluster", name: "homelab", quorate: 1, nodes: 2 },
  { type: "node", name: "pve1", online: 1 },
]);

const DOMAIN_XML_A = `<domain type='kvm' id='3'>
  <name>vm-a</name>
  <uuid>AA0E349F-91C4-46A1-B9A4-6BE1C1B7A701</uuid>
  <vcpu placement='static'>4</vcpu>
  <memory unit='KiB'>4194304</memory>
  <devices>
    <interface type='network'>
      <mac address='52:54:00:AB:CD:01'/>
    </interface>
    <interface type='bridge'>
      <mac address='52:54:00:AB:CD:02'/>
    </interface>
  </devices>
</domain>`;

const DOMAIN_XML_B = `<domain type='kvm'>
  <name>vm-b</name>
  <uuid>bb1f45a0-02d5-57b2-cab5-7cf2d2c8b802</uuid>
  <vcpu>2</vcpu>
  <memory unit='GiB'>2</memory>
</domain>`;

// ── Detection predicates ──────────────────────────────────────────────────────────────────────────

describe("isPveFuseMounted (ADR-0095 §2)", () => {
  test("a fuse-mounted /etc/pve is the positive signal", () => {
    expect(isPveFuseMounted(PVE_MOUNTS)).toBe(true);
  });

  test("a plain /etc/pve directory (leftover from a removed install) does NOT fire", () => {
    // The whole reason the predicate reads /proc/mounts instead of `test -d /etc/pve`: a dead
    // pmxcfs leaves the directory behind, and detection must mean "the cluster fs is ALIVE".
    expect(isPveFuseMounted(PLAIN_MOUNTS)).toBe(false);
  });

  test("a fuse mount somewhere ELSE does not fire", () => {
    expect(
      isPveFuseMounted("appimage /tmp/.mount_fooBAR fuse.appimage rw,nosuid,nodev 0 0"),
    ).toBe(false);
  });

  test("a fuse.pmxcfs-style subtype still fires — the fstype prefix is what matters", () => {
    expect(isPveFuseMounted("/dev/fuse /etc/pve fuse.pmxcfs rw,nosuid 0 0")).toBe(true);
  });

  test("an unreadable /proc/mounts is a negative, never a crash", () => {
    expect(isPveFuseMounted(null)).toBe(false);
  });
});

describe("pveNodeName — the /etc/pve/local symlink, never the hostname", () => {
  test("basename of the resolved symlink target", () => {
    expect(pveNodeName("/etc/pve/nodes/pve1\n")).toBe("pve1");
  });

  test("an UNRESOLVED link (readlink echoing the link itself) is rejected", () => {
    // `local` is the link's own name, not a node name — trusting it would name every PVE host in
    // the estate "local" and collapse the per-node guest scoping the ADR relies on.
    expect(pveNodeName("/etc/pve/local")).toBeUndefined();
  });

  test("null, empty and junk answers are rejected rather than guessed", () => {
    expect(pveNodeName(null)).toBeUndefined();
    expect(pveNodeName("")).toBeUndefined();
    expect(pveNodeName("   \n")).toBeUndefined();
    expect(pveNodeName("/etc/pve/nodes/has space")).toBeUndefined();
  });
});

// ── pvesh parsers ─────────────────────────────────────────────────────────────────────────────────

describe("parsePveGuestList", () => {
  test("maps vmid/name/status/maxmem from a qemu list", () => {
    const rows = parsePveGuestList(QEMU_LIST);
    expect(rows).toEqual([
      { vmid: "101", name: "web01", state: "running", memoryBytes: 4294967296 },
      { vmid: "102", name: "db01", state: "stopped", memoryBytes: 8589934592 },
    ]);
  });

  test("null (pvesh failed) is undefined — enumeration FAILED, not 'no guests'", () => {
    expect(parsePveGuestList(null)).toBeUndefined();
  });

  test("a non-array body is undefined — an error object must not read as an empty host", () => {
    expect(parsePveGuestList('{"errors":"permission denied"}')).toBeUndefined();
    expect(parsePveGuestList("not json at all")).toBeUndefined();
  });

  test("an empty array is an EMPTY list — the probe ran and found none", () => {
    expect(parsePveGuestList("[]")).toEqual([]);
  });

  test("a row without a usable vmid is dropped; a string vmid is accepted", () => {
    const rows = parsePveGuestList(
      JSON.stringify([{ name: "ghost" }, { vmid: "103", name: "ok", status: "running" }]),
    );
    expect(rows?.map((r) => r.vmid)).toEqual(["103"]);
  });

  test("an unenumerated status folds to 'other'; a missing one stays absent", () => {
    const rows = parsePveGuestList(
      JSON.stringify([
        { vmid: 1, name: "a", status: "prelaunch" },
        { vmid: 2, name: "b" },
        { vmid: 3, name: "c", status: "paused" },
        { vmid: 4, name: "d", status: "suspended" },
      ]),
    );
    expect(rows?.map((r) => r.state)).toEqual(["other", undefined, "paused", "suspended"]);
  });

  test("a row with no name falls back to the vmid, so the schema keeps the guest", () => {
    const rows = parsePveGuestList(JSON.stringify([{ vmid: 105, status: "running" }]));
    expect(rows?.[0]?.name).toBe("105");
  });
});

describe("parsePveConfig", () => {
  test("extracts the smbios1 uuid, every netN MAC, cores and ostype from a qemu config", () => {
    expect(parsePveConfig(QEMU_CONFIG_101)).toEqual({
      smbiosUuid: "d0f2c3a4-1b2c-4d5e-8f90-112233445566",
      macs: ["bc:24:11:2a:3b:4c", "bc:24:11:2a:3b:4d"],
      cores: 2,
      osHint: "l26",
    });
  });

  test("finds uuid= amid other smbios1 keys, whatever the order", () => {
    const cfg = parsePveConfig(
      JSON.stringify({ smbios1: "manufacturer=QEMU,uuid=ABCDEF01-2345-6789-ABCD-EF0123456789,product=Standard" }),
    );
    expect(cfg?.smbiosUuid).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  test("a config with no smbios1 (every LXC, some VMs) simply omits the uuid", () => {
    const cfg = parsePveConfig(LXC_CONFIG_200);
    expect(cfg?.smbiosUuid).toBeUndefined();
    // …but the LXC hwaddr= MAC is still identity evidence, extracted by shape, not by key name.
    expect(cfg?.macs).toEqual(["bc:24:11:aa:bb:cc"]);
    expect(cfg).toMatchObject({ cores: 1, osHint: "debian" });
  });

  test("a smbios1 without a uuid key contributes nothing", () => {
    expect(parsePveConfig(JSON.stringify({ smbios1: "manufacturer=QEMU" }))?.smbiosUuid).toBeUndefined();
  });

  test("null and malformed JSON are undefined — the guest still ships from its list row", () => {
    expect(parsePveConfig(null)).toBeUndefined();
    expect(parsePveConfig("pvesh: got timeout")).toBeUndefined();
  });
});

describe("parsePveClusterName / parsePveVersion", () => {
  test("the cluster row of /cluster/status names the cluster", () => {
    expect(parsePveClusterName(CLUSTER_STATUS)).toBe("homelab");
  });

  test("a standalone node (no cluster row) has none", () => {
    expect(
      parsePveClusterName(JSON.stringify([{ type: "node", name: "pve1", online: 1 }])),
    ).toBeUndefined();
    expect(parsePveClusterName(null)).toBeUndefined();
  });

  test("pveversion's pve-manager/X.Y.Z/... yields the version", () => {
    expect(parsePveVersion("pve-manager/8.2.4/faa83925c9641325 (running kernel: 6.8.12-1-pve)\n")).toBe(
      "8.2.4",
    );
    expect(parsePveVersion("something else")).toBeUndefined();
    expect(parsePveVersion(null)).toBeUndefined();
  });
});

// ── virsh parsers ─────────────────────────────────────────────────────────────────────────────────

describe("parseVirshNameList", () => {
  test("one name per line, blanks dropped", () => {
    expect(parseVirshNameList("vm-a\nvm-b\n\n")).toEqual(["vm-a", "vm-b"]);
  });

  test("empty output is an EMPTY list (no domains); null is undefined (virsh failed)", () => {
    expect(parseVirshNameList("")).toEqual([]);
    expect(parseVirshNameList(null)).toBeUndefined();
  });
});

describe("parseVirshDomainXml", () => {
  test("uuid, vcpu, KiB memory and every interface MAC from a dumpxml document", () => {
    expect(parseVirshDomainXml(DOMAIN_XML_A)).toEqual({
      uuid: "aa0e349f-91c4-46a1-b9a4-6be1c1b7a701",
      cores: 4,
      memoryBytes: 4294967296,
      macs: ["52:54:00:ab:cd:01", "52:54:00:ab:cd:02"],
    });
  });

  test("memory units convert to bytes — GiB, MiB, bytes, and the KiB default", () => {
    const xml = (memory: string) =>
      `<domain><uuid>bb1f45a0-02d5-57b2-cab5-7cf2d2c8b802</uuid>${memory}</domain>`;
    expect(parseVirshDomainXml(xml("<memory unit='GiB'>2</memory>"))?.memoryBytes).toBe(2 ** 31);
    expect(parseVirshDomainXml(xml("<memory unit='MiB'>512</memory>"))?.memoryBytes).toBe(512 * 2 ** 20);
    expect(parseVirshDomainXml(xml("<memory unit='bytes'>1048576</memory>"))?.memoryBytes).toBe(1048576);
    // libvirt's documented default when the attribute is absent is KiB.
    expect(parseVirshDomainXml(xml("<memory>1024</memory>"))?.memoryBytes).toBe(1024 * 1024);
    // An unrecognised unit omits the fact rather than guessing a multiplier.
    expect(parseVirshDomainXml(xml("<memory unit='parsecs'>3</memory>"))?.memoryBytes).toBeUndefined();
  });

  test("a document with no uuid is undefined — there is no stable ref to key the guest on", () => {
    expect(parseVirshDomainXml("<domain><name>vm-x</name></domain>")).toBeUndefined();
    expect(parseVirshDomainXml("error: failed to get domain 'vm-x'")).toBeUndefined();
    expect(parseVirshDomainXml(null)).toBeUndefined();
  });
});

// ── The orchestrator, with injected probes ────────────────────────────────────────────────────────

/** Scripted deps: file contents by path, exec answers by joined argv, and a call log. */
function fakeDeps(fixture: {
  files?: Record<string, string>;
  paths?: string[];
  binaries?: string[];
  exec?: Record<string, string>;
}): LinuxHypervisorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    readText: async (path) => fixture.files?.[path] ?? null,
    pathExists: async (path) => fixture.paths?.includes(path) ?? false,
    which: (name) => (fixture.binaries?.includes(name) ? `/usr/bin/${name}` : null),
    exec: async (args) => {
      calls.push(args);
      return fixture.exec?.[args.join(" ")] ?? null;
    },
  };
}

const PVE_EXEC = {
  "readlink -f /etc/pve/local": "/etc/pve/nodes/pve1\n",
  pveversion: "pve-manager/8.2.4/faa83925c9641325 (running kernel: 6.8.12-1-pve)\n",
  "pvesh get /cluster/status --output-format json": CLUSTER_STATUS,
  "pvesh get /nodes/pve1/qemu --output-format json": QEMU_LIST,
  "pvesh get /nodes/pve1/lxc --output-format json": LXC_LIST,
  "pvesh get /nodes/pve1/qemu/101/config --output-format json": QEMU_CONFIG_101,
  "pvesh get /nodes/pve1/qemu/102/config --output-format json": JSON.stringify({ cores: 4 }),
  "pvesh get /nodes/pve1/lxc/200/config --output-format json": LXC_CONFIG_200,
};

describe("collectHypervisorLinux — Proxmox", () => {
  test("the full happy path: facet + qemu and lxc guests, identity from each config", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec: PVE_EXEC }),
    );
    expect(out?.hypervisor).toEqual({
      platform: "proxmox",
      version: "8.2.4",
      clusterName: "homelab",
      nodeName: "pve1",
    });
    expect(out?.guests).toEqual([
      {
        ref: "101",
        name: "web01",
        kind: "qemu",
        state: "running",
        memoryBytes: 4294967296,
        smbiosUuid: "d0f2c3a4-1b2c-4d5e-8f90-112233445566",
        macs: ["bc:24:11:2a:3b:4c", "bc:24:11:2a:3b:4d"],
        cores: 2,
        osHint: "l26",
      },
      { ref: "102", name: "db01", kind: "qemu", state: "stopped", memoryBytes: 8589934592, cores: 4 },
      {
        ref: "200",
        name: "ct-dns",
        kind: "lxc",
        state: "running",
        memoryBytes: 536870912,
        macs: ["bc:24:11:aa:bb:cc"],
        cores: 1,
        osHint: "debian",
      },
    ]);
    expect(notes).toEqual([]);
  });

  test("zero guests on both lists is guests: [] — a positive finding, not an omitted key", async () => {
    const { warn } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: { "/proc/mounts": PVE_MOUNTS },
        exec: { ...PVE_EXEC, "pvesh get /nodes/pve1/qemu --output-format json": "[]", "pvesh get /nodes/pve1/lxc --output-format json": "[]" },
      }),
    );
    expect(out?.guests).toEqual([]);
  });

  test("a failed enumeration keeps the facet, OMITS guests, and warns — absent ≠ empty", async () => {
    // The load-bearing rule: `[]` retires the server's child nodes, so a wedged pvesh must never
    // masquerade as an empty host. Either list failing degrades the WHOLE guest key.
    const { warn, notes } = sink();
    const exec = { ...PVE_EXEC };
    delete (exec as Record<string, string>)["pvesh get /nodes/pve1/lxc --output-format json"];
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec }),
    );
    expect(out?.hypervisor?.platform).toBe("proxmox");
    expect(out?.guests).toBeUndefined();
    expect(notes.join(" ")).toContain("hypervisor");
  });

  test("an unresolvable node name degrades the same way: facet + warning, no guests", async () => {
    const { warn, notes } = sink();
    const exec = { ...PVE_EXEC };
    delete (exec as Record<string, string>)["readlink -f /etc/pve/local"];
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec }),
    );
    expect(out?.hypervisor?.platform).toBe("proxmox");
    expect(out?.guests).toBeUndefined();
    expect(notes.length).toBeGreaterThan(0);
  });

  test("a per-guest config failure costs that guest its identity evidence, never the guest", async () => {
    const { warn, notes } = sink();
    const exec = { ...PVE_EXEC };
    delete (exec as Record<string, string>)["pvesh get /nodes/pve1/qemu/101/config --output-format json"];
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec }),
    );
    const g101 = out?.guests?.find((g) => g.ref === "101");
    expect(g101).toMatchObject({ name: "web01", kind: "qemu" });
    expect(g101?.smbiosUuid).toBeUndefined();
    expect(notes.join(" ")).toContain("config");
  });

  test("Proxmox WINS over libvirt signals on the same box — virsh is never invoked", async () => {
    // A PVE node is also Debian with /dev/kvm, and virsh there sees NOTHING (Proxmox does not use
    // libvirt) — most-specific-wins is what keeps the real guest list from being shadowed by an
    // empty one.
    const deps = fakeDeps({
      files: { "/proc/mounts": PVE_MOUNTS },
      paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string],
      binaries: ["virsh"],
      exec: PVE_EXEC,
    });
    await collectHypervisorLinux(sink().warn, AGENT_POLICY_DEFAULT, deps);
    expect(deps.calls.every((args) => args[0] !== "virsh")).toBe(true);
  });
});

describe("collectHypervisorLinux — XCP-ng (detected, not collected)", () => {
  test("dom0 yields the facet, ONE honest warning, and no guests key", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: {
          "/proc/mounts": PLAIN_MOUNTS,
          "/proc/xen/capabilities": "control_d\n",
        },
        paths: ["/etc/xensource-inventory"],
      }),
    );
    expect(out).toEqual({ hypervisor: { platform: "xcpng" } });
    expect(out && "guests" in out && out.guests !== undefined).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not yet supported");
  });

  test("a Xen domU (capabilities without control_d) does NOT fire", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: { "/proc/mounts": PLAIN_MOUNTS, "/proc/xen/capabilities": "\n" },
        paths: ["/etc/xensource-inventory"],
      }),
    );
    expect(out).toBeUndefined();
    expect(notes).toEqual([]);
  });
});

describe("collectHypervisorLinux — libvirt", () => {
  const LIBVIRT_FILES = { "/proc/mounts": PLAIN_MOUNTS };
  const LIBVIRT_EXEC = {
    "virsh -c qemu:///system list --all --name": "vm-a\nvm-b\n\n",
    "virsh -c qemu:///system list --name --state-running": "vm-a\n",
    "virsh -c qemu:///system list --name --state-paused": "",
    "virsh -c qemu:///system dumpxml vm-a": DOMAIN_XML_A,
    "virsh -c qemu:///system dumpxml vm-b": DOMAIN_XML_B,
  };

  test("the happy path: domain uuid is both ref and smbiosUuid; state from the filtered lists", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: LIBVIRT_FILES,
        paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string],
        binaries: ["virsh"],
        exec: LIBVIRT_EXEC,
      }),
    );
    expect(out?.hypervisor).toEqual({ platform: "libvirt" });
    expect(out?.guests).toEqual([
      {
        ref: "aa0e349f-91c4-46a1-b9a4-6be1c1b7a701",
        name: "vm-a",
        kind: "libvirt",
        state: "running",
        smbiosUuid: "aa0e349f-91c4-46a1-b9a4-6be1c1b7a701",
        macs: ["52:54:00:ab:cd:01", "52:54:00:ab:cd:02"],
        cores: 4,
        memoryBytes: 4294967296,
      },
      {
        ref: "bb1f45a0-02d5-57b2-cab5-7cf2d2c8b802",
        name: "vm-b",
        kind: "libvirt",
        state: "stopped",
        smbiosUuid: "bb1f45a0-02d5-57b2-cab5-7cf2d2c8b802",
        cores: 2,
        memoryBytes: 2 ** 31,
      },
    ]);
    expect(notes).toEqual([]);
  });

  test("a malformed dumpxml drops THAT domain, not the collection", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: LIBVIRT_FILES,
        paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string],
        binaries: ["virsh"],
        exec: { ...LIBVIRT_EXEC, "virsh -c qemu:///system dumpxml vm-b": "error: Domain not found" },
      }),
    );
    expect(out?.guests?.map((g) => g.name)).toEqual(["vm-a"]);
    expect(notes.join(" ")).toContain("1");
  });

  test("a failed domain enumeration keeps the facet, omits guests, and warns", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: LIBVIRT_FILES,
        paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string],
        binaries: ["virsh"],
        exec: {},
      }),
    );
    expect(out?.hypervisor).toEqual({ platform: "libvirt" });
    expect(out?.guests).toBeUndefined();
    expect(notes.length).toBeGreaterThan(0);
  });

  test("when the running/paused list calls fail, state is OMITTED rather than invented", async () => {
    // Membership in a set that could not be enumerated proves nothing: claiming 'stopped' for every
    // domain because a filter query failed would flip real running guests to stopped on the map.
    const { warn } = sink();
    const exec = { ...LIBVIRT_EXEC };
    delete (exec as Record<string, string>)["virsh -c qemu:///system list --name --state-running"];
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({
        files: LIBVIRT_FILES,
        paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string],
        binaries: ["virsh"],
        exec,
      }),
    );
    expect(out?.guests?.map((g) => g.state)).toEqual([undefined, undefined]);
  });

  test("/dev/kvm without virsh is a CAPABILITY, not an acting hypervisor — silent nothing", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: LIBVIRT_FILES, paths: ["/dev/kvm", LIBVIRT_SOCKETS[0] as string] }),
    );
    expect(out).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("virsh + /dev/kvm without a daemon (no socket, systemctl says inactive) stays silent", async () => {
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(
      warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: LIBVIRT_FILES, paths: ["/dev/kvm"], binaries: ["virsh"] }),
    );
    expect(out).toBeUndefined();
    expect(notes).toEqual([]);
  });
});

describe("collectHypervisorLinux — the policy gate and the quiet default", () => {
  test("collect.hypervisor=false: nothing probed, one 'disabled by agent policy' warning", async () => {
    const { warn, notes } = sink();
    const deps = fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec: PVE_EXEC });
    const out = await collectHypervisorLinux(
      warn,
      policy({ collect: { ...AGENT_POLICY_DEFAULT.collect, hypervisor: false } }),
      deps,
    );
    expect(out).toBeUndefined();
    expect(deps.calls).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("disabled by agent policy");
  });

  test("an ordinary host (no hypervisor anywhere) is SILENT — no facet, no guests, no warning", async () => {
    // The overwhelmingly common case: warning here would put a line in the majority of the
    // estate's reports until operators learned to ignore the field (the containers-probe rule).
    const { warn, notes } = sink();
    const out = await collectHypervisorLinux(warn, AGENT_POLICY_DEFAULT, fakeDeps({ files: { "/proc/mounts": PLAIN_MOUNTS } }));
    expect(out).toBeUndefined();
    expect(notes).toEqual([]);
  });
});

describe("the collected shape survives the wire contract", () => {
  test("a report carrying the collector's own output validates against AgentReportSchema", async () => {
    const out = await collectHypervisorLinux(
      sink().warn,
      AGENT_POLICY_DEFAULT,
      fakeDeps({ files: { "/proc/mounts": PVE_MOUNTS }, exec: PVE_EXEC }),
    );
    const parsed = AgentReportSchema.safeParse({
      agentVersion: "dev",
      reportingSource: "agent:0123456789ab",
      externalId: "0123456789abcdef",
      reportedAt: new Date().toISOString(),
      host: { hostname: "pve1", hypervisor: out?.hypervisor, guests: out?.guests },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.host.hypervisor).toEqual(out?.hypervisor);
      // The schema keeps every guest the collector shipped — nothing is dropped or re-spelled.
      expect(parsed.data.host.guests).toEqual(out?.guests);
    }
  });
});
