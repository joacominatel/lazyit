/**
 * Linux host fact collection (ADR-0074 §7). Every fact is BEST-EFFORT: a missing tool, missing file
 * or missing privilege is silently omitted, never fatal — a partial report is valid (ADR-0074 §2/§3).
 * The only hard requirements are `hostname` (always available) and `/etc/machine-id` (the dedup key,
 * handled by the caller). Linux-only by design; the wire contract is OS-neutral for future targets.
 *
 * Contract v2 (#1138) adds what this collector can honestly determine on Linux TODAY: the `os.family`
 * discriminator, the SMBIOS chassis type, the virtualization probe, corroborating identifiers, IPv6 +
 * virtual-interface flags on NICs, the boot instant, package-manager provenance — and `warnings`, the
 * one that changes what an operator can SEE. Everything else here degrades a failure to an omitted
 * fact, which leaves an empty column that looks identical whether the host lacks `dmidecode`, the
 * agent lacks root, or a collector hung. The warnings sink is where that difference survives.
 */
import { hostname as osHostname } from "node:os";
import type {
  AgentChassis,
  AgentReport,
  AgentVirtualizationType,
} from "@lazyit/shared";

type Host = AgentReport["host"];
type Software = NonNullable<AgentReport["software"]>;
type Nics = NonNullable<Host["nics"]>;
type Identifiers = NonNullable<Host["identifiers"]>;

/**
 * Where a degraded collector reports itself (#1138). A sink rather than a return value because a
 * warning is orthogonal to the fact: `run()` still returns `null`, every caller still degrades
 * exactly as before, and the note simply rides along to `diagnostics.warnings`.
 */
export type Warn = (message: string) => void;

/** A no-op sink, so every collector stays callable without threading diagnostics through. */
const NO_WARN: Warn = () => {};

/**
 * Per-command budget (#1133). Every collector is a local read that finishes in milliseconds on a
 * healthy host, so ten seconds is pure headroom — it exists to bound the PATHOLOGICAL host, not the
 * normal one. Kept well under install.sh's `RuntimeMaxSec=120` so a degraded host still assembles
 * and sends a PARTIAL report before systemd kills the unit; reporting less beats reporting nothing.
 */
export const COLLECT_TIMEOUT_MS = 10_000;

/** Marks the guaranteed-return race below, so a genuinely unreapable child is distinguishable. */
const ABANDONED = Symbol("abandoned");

/**
 * Run a command, returning stdout on success or null on ANY failure (missing binary, non-zero
 * exit, timeout, …) — the best-effort contract the whole collector is built on.
 *
 * Uses `Bun.spawn` rather than Bun Shell (`$`) for ONE reason: `$` exposes no timeout, and an
 * unbounded collector is how a wedged `lsblk` on a degraded NFS mount (or `dmidecode` on a bad BMC)
 * hung the agent forever — leaving the systemd unit in `activating`, which never re-arms the timer,
 * which makes the host look OFFLINE when only the agent was stuck.
 *
 * Two layers, deliberately: `Bun.spawn`'s own timeout KILLS the child, and the race guarantees this
 * function RETURNS even in the case the kill cannot land — a process blocked in uninterruptible I/O
 * ignores SIGKILL until the I/O completes, which is precisely the NFS scenario. Layer three is
 * systemd's RuntimeMaxSec, which reaps the whole cgroup if a child outlives us.
 *
 * `warn` (#1138) receives a note for the two DEGRADED outcomes — the binary was unusable, or the
 * command had to be killed. A plain non-zero exit is deliberately silent: it is an ANSWER, not a
 * degradation (`systemd-detect-virt` exits 1 to say "bare metal"), and warning on it would put a
 * line in every physical host's report until the operator learned to ignore the field.
 */
export async function run(
  args: string[],
  timeoutMs = COLLECT_TIMEOUT_MS,
  warn: Warn = NO_WARN,
): Promise<string | null> {
  const command = args[0];
  const collect = async (): Promise<string | null> => {
    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode === 0) return stdout;
      // No exit code + our own kill signal ⇒ the spawn timeout fired, not the program answering.
      if (proc.exitCode === null && proc.signalCode === "SIGKILL") {
        warn(`${command}: timed out after ${timeoutMs}ms — fact omitted`);
      }
      return null;
    } catch {
      // missing binary (ENOENT), permission denied, …
      warn(`${command}: unavailable (missing binary or not permitted) — fact omitted`);
      return null;
    }
  };

  // The grace margin lets the kill land and `exited` settle normally in the common case, so this
  // fallback only wins when the child is genuinely unreapable.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new Promise<typeof ABANDONED>((resolve) => {
    timer = setTimeout(() => resolve(ABANDONED), timeoutMs + 500);
  });

  try {
    const outcome = await Promise.race([collect(), abandon]);
    if (outcome === ABANDONED) {
      warn(`${command}: timed out and could not be reaped — fact omitted`);
      return null;
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a file as text, or null if it does not exist / is unreadable. */
async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** Does this path exist and is it readable? Used to tell a physical NIC from a virtual one. */
async function exists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

/** Drop undefined/null/empty-string values; return undefined if nothing survives (omit the key). */
function clean<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Parse a `KEY=VALUE` blob (os-release style), stripping surrounding quotes. */
function parseKeyVal(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    out[key] = raw.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** `/etc/machine-id` (the stable per-OS-install dedup key), falling back to the D-Bus location. */
export async function readMachineId(): Promise<string | null> {
  const id =
    (await readText("/etc/machine-id")) ?? (await readText("/var/lib/dbus/machine-id"));
  const trimmed = id?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The `os` block. `family` is stamped UNCONDITIONALLY (#1138) — this binary is the Linux collector,
 * so the answer is known even when `/etc/os-release` is unreadable, and every downstream consumer
 * branches on it. `build` carries `BUILD_ID` where the distro sets one (immutable/atomic images).
 */
export function collectOs(osRelease: string | null, kernel: string | null): Host["os"] {
  const kv = osRelease ? parseKeyVal(osRelease) : {};
  return {
    family: "linux",
    ...clean({
      name: kv.NAME,
      version: kv.VERSION_ID,
      kernel: kernel?.trim(),
      build: kv.BUILD_ID,
    }),
  };
}

function collectCpu(cpuinfo: string | null): Host["cpu"] {
  if (!cpuinfo) return undefined;
  const model = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim();
  const cores = cpuinfo.match(/^processor\s*:/gm)?.length;
  return clean({ model, cores });
}

function collectMemoryBytes(meminfo: string | null): number | undefined {
  const kb = meminfo?.match(/^MemTotal:\s*(\d+)\s*kB/m)?.[1];
  return kb ? Number(kb) * 1024 : undefined;
}

/**
 * When the host last booted, from `/proc/stat`'s `btime` (#1138). `btime` is an ABSOLUTE epoch
 * instant, unlike `/proc/uptime`'s elapsed seconds: derived from uptime, the reported timestamp would
 * drift by a second or two on every check-in and every consumer would have to treat "did it reboot?"
 * as a fuzzy comparison. Absent/garbage ⇒ omitted, never fabricated.
 */
export function parseBootedAt(procStat: string | null): string | undefined {
  const seconds = Number(procStat?.match(/^btime\s+(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * `systemd-detect-virt` names that differ from the contract's vocabulary (#1138). `qemu` maps to
 * `kvm` because the operator-visible fact is "a QEMU/KVM guest" (plain TCG emulation on a server
 * estate is vanishingly rare); `microsoft` is Hyper-V; `podman`/`lxc-libvirt`/`systemd-nspawn` are
 * the same container shapes the contract already names.
 */
const VIRT_ALIASES: Record<string, AgentVirtualizationType> = {
  microsoft: "hyperv",
  qemu: "kvm",
  podman: "docker",
  "lxc-libvirt": "lxc",
  "systemd-nspawn": "lxc",
};

/** The contract's vocabulary, as a runtime set (the enum is erased at compile time). */
const VIRT_TYPES = new Set<string>([
  "none",
  "kvm",
  "vmware",
  "hyperv",
  "xen",
  "lxc",
  "docker",
  "wsl",
  "other",
]);

/**
 * Map one `systemd-detect-virt` value onto the contract's vocabulary (#1138). detect-virt alone emits
 * ~30 values and every hypervisor vendor adds more, so anything unrecognised becomes `other`:
 * "virtualized, kind unknown" is a true and useful fact, and it keeps an unenumerated hypervisor from
 * costing the operator a host.
 */
export function mapVirtualizationType(raw: string): AgentVirtualizationType {
  const value = raw.trim().toLowerCase();
  const alias = VIRT_ALIASES[value];
  if (alias) return alias;
  return VIRT_TYPES.has(value) ? (value as AgentVirtualizationType) : "other";
}

/** Container runtimes — the virtualization types that make the host a CONTAINER, not a VM. */
const CONTAINER_VIRT = new Set<AgentVirtualizationType>(["docker", "lxc", "wsl"]);

/**
 * SMBIOS chassis type → the contract's chassis vocabulary (DMTF DSP0134 §7.4.1). Only the codes with
 * an unambiguous meaning are mapped; everything else (Other, Unknown, Docking Station, Peripheral, …)
 * stays `unknown`, because a wrong classification is worse than none — #1139 will infer `kind` from
 * this field, and "unknown" leaves the human's call intact where a guess would silently pre-empt it.
 */
const SMBIOS_CHASSIS: Record<number, AgentChassis> = {
  3: "desktop", // Desktop
  4: "desktop", // Low Profile Desktop
  5: "desktop", // Pizza Box
  6: "desktop", // Mini Tower
  7: "desktop", // Tower
  8: "laptop", // Portable
  9: "laptop", // Laptop
  10: "laptop", // Notebook
  13: "desktop", // All in One
  14: "laptop", // Sub Notebook
  15: "desktop", // Space-saving
  16: "desktop", // Lunch Box
  17: "server", // Main Server Chassis
  23: "server", // Rack Mount Chassis
  24: "desktop", // Sealed-case PC
  25: "server", // Multi-system Chassis
  28: "server", // Blade
  29: "server", // Blade Enclosure
  30: "laptop", // Tablet
  31: "laptop", // Convertible
  32: "laptop", // Detachable
};

/**
 * What the host IS (#1138) — the virtualization probe WINS over SMBIOS, because a guest inherits its
 * hypervisor's synthetic board: DMI happily calls a KVM guest a "desktop" (chassis type 3), which is
 * exactly the misclassification #1139 must not inherit. Only a host detect-virt calls bare metal
 * falls through to its chassis code; an unrecognised (`other`) virtualization still means virtualized.
 */
export function chassisFor(
  virtualization: AgentVirtualizationType,
  smbiosChassisType: string | null,
): AgentChassis {
  if (CONTAINER_VIRT.has(virtualization)) return "container";
  if (virtualization !== "none") return "vm";
  const code = Number(smbiosChassisType?.trim());
  if (!Number.isInteger(code)) return "unknown";
  return SMBIOS_CHASSIS[code] ?? "unknown";
}

/**
 * The host's virtualization (#1138). A `none` here is a POSITIVE bare-metal finding, so it is only
 * reported when the probe genuinely ran: no `systemd-detect-virt` (or a degraded one) omits the key
 * entirely rather than claiming bare metal on no evidence. Exit 1 IS the "none" answer — hence the
 * `degraded` flag instead of reading `null` as failure.
 */
async function collectVirtualization(warn: Warn): Promise<Host["virtualization"]> {
  if (!Bun.which("systemd-detect-virt")) return undefined;
  let degraded = false;
  const out = await run(["systemd-detect-virt"], COLLECT_TIMEOUT_MS, (message) => {
    degraded = true;
    warn(message);
  });
  if (degraded) return undefined;
  const raw = out?.trim();
  return { type: raw ? mapVirtualizationType(raw) : "none" };
}

interface LsblkDevice {
  name?: string;
  size?: number | string;
  type?: string;
  mountpoint?: string | null;
  children?: LsblkDevice[];
}

async function collectDisks(warn: Warn): Promise<Host["disks"]> {
  const out = await run(["lsblk", "-bJ", "-o", "NAME,SIZE,TYPE,MOUNTPOINT"], COLLECT_TIMEOUT_MS, warn);
  if (!out) return undefined;
  let parsed: { blockdevices?: LsblkDevice[] };
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  const disks = (parsed.blockdevices ?? [])
    .filter((d) => d.type === "disk" && d.name)
    .map((d) => {
      const mountpoint =
        d.mountpoint ?? d.children?.find((c) => c.mountpoint)?.mountpoint ?? undefined;
      return clean({
        device: `/dev/${d.name}`,
        sizeBytes: d.size != null ? Number(d.size) : undefined,
        mountpoint: mountpoint ?? undefined,
      });
    })
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  return disks.length ? disks.slice(0, 256) : undefined;
}

interface IpAddr {
  ifname?: string;
  address?: string;
  addr_info?: Array<{ family?: string; local?: string }>;
}

/**
 * Parse `ip -j addr` into the contract's NIC shape (#1138). BOTH families now: v1 carried IPv4 only
 * while the shared `IpAddressSchema` had always accepted v6, so a v6-only host reported no address at
 * all. Link-local (`fe80::`) addresses are kept verbatim — the collector reports what the interface
 * has, and the server's promotion mapper decides what is worth showing as the node's IP. Loopback is
 * dropped (it is never a host fact worth inventorying).
 */
export function parseNics(out: string | null): Nics | undefined {
  if (!out) return undefined;
  let parsed: IpAddr[];
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  const nics: Nics = [];
  for (const n of parsed) {
    const name = n.ifname;
    if (!name || name === "lo") continue;
    const addresses = n.addr_info ?? [];
    const ipv4 = addresses.filter((a) => a.family === "inet" && a.local).map((a) => a.local!);
    const ipv6 = addresses.filter((a) => a.family === "inet6" && a.local).map((a) => a.local!);
    const nic: Nics[number] = { name };
    if (n.address) nic.mac = n.address;
    if (ipv4.length) nic.ipv4 = ipv4.slice(0, 64);
    if (ipv6.length) nic.ipv6 = ipv6.slice(0, 64);
    nics.push(nic);
  }
  return nics.length ? nics.slice(0, 64) : undefined;
}

/**
 * NICs, with each interface flagged virtual or not (#1138). A physical NIC has a backing device under
 * `/sys/class/net/<name>/device`; veth/bridge/bond/tun interfaces do not — which is what lets a
 * consumer ignore the container plumbing (`docker0`, `veth*`, `br-*`) that otherwise dominates the
 * NIC list on any host running containers. When `/sys` cannot answer for an interface at all, the
 * flag is LEFT OFF rather than guessed: absent means "unknown", false would mean "physical".
 */
async function collectNics(warn: Warn): Promise<Host["nics"]> {
  const nics = parseNics(await run(["ip", "-j", "addr"], COLLECT_TIMEOUT_MS, warn));
  if (!nics) return undefined;
  for (const nic of nics) {
    if (!(await exists(`/sys/class/net/${nic.name}/type`))) continue;
    nic.isVirtual = !(await exists(`/sys/class/net/${nic.name}/device/uevent`));
  }
  return nics;
}

/** dmidecode facts — ROOT ONLY (and only if dmidecode is installed); degrade silently otherwise. */
async function collectHardware(warn: Warn): Promise<Host["hardware"]> {
  if (process.getuid?.() !== 0) {
    // The single most common "why is this row empty?" on a real estate — now answerable (#1138).
    warn("hardware: skipped — dmidecode needs root; manufacturer/model/serial omitted");
    return undefined;
  }
  const [manufacturer, model, serial] = await Promise.all([
    run(["dmidecode", "-s", "system-manufacturer"], COLLECT_TIMEOUT_MS, warn),
    run(["dmidecode", "-s", "system-product-name"], COLLECT_TIMEOUT_MS, warn),
    run(["dmidecode", "-s", "system-serial-number"], COLLECT_TIMEOUT_MS, warn),
  ]);
  return clean({
    manufacturer: manufacturer?.trim(),
    model: model?.trim(),
    serial: serial?.trim(),
  });
}

/** The identity facts this host can offer, whatever it happens to have. */
export interface IdentifierFacts {
  machineId?: string | null;
  smbiosUuid?: string | null;
  serial?: string | null;
  mac?: string | null;
}

/**
 * The corroborating identifier set (#1138) — evidence #1141 will use to recognise the SAME host after
 * a re-install or a NIC swap. `externalId` remains the primary dedup key (ADR-0074 §3: one host = one
 * node, forever); nothing here is a second key. Empty facts are omitted, and an empty SET omits the
 * whole array rather than shipping `[]` (a partial report says nothing, it does not say "none").
 */
export function buildIdentifiers(facts: IdentifierFacts): Identifiers | undefined {
  const kinds = [
    ["machine-id", facts.machineId],
    ["smbios-uuid", facts.smbiosUuid],
    ["serial", facts.serial],
    ["mac", facts.mac],
  ] as const;
  const identifiers: Identifiers = [];
  for (const [kind, raw] of kinds) {
    const value = raw?.trim();
    if (value) identifiers.push({ kind, value: value.slice(0, 200) });
  }
  return identifiers.length ? identifiers : undefined;
}

const SOFTWARE_CAP = 5000; // matches AgentReportSchema's software array max

/**
 * Parse `name<TAB>version` lines (dpkg-query / rpm output), stamping the manager that produced them
 * (#1138) — provenance is what makes a cross-OS software list comparable instead of a bag of strings.
 */
export function parseTabbed(
  out: string | null,
  source: "dpkg" | "rpm",
): Software {
  if (!out) return [];
  const pkgs: Software = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, version] = line.split("\t");
    if (name?.trim()) {
      pkgs.push({ name: name.trim(), ...(version?.trim() ? { version: version.trim() } : {}), source });
    }
  }
  return pkgs;
}

/**
 * Parse `apk info -v` lines like `musl-1.2.4-r2` into name + version. apk has no field-format flag, so
 * we split on the `-<pkgver>-r<pkgrel>` tail. // ponytail: a pathological package name could fool the
 * regex; the worst case is a slightly-off name/version string, never a crash or an invalid report.
 */
function parseApk(out: string | null): Software {
  if (!out) return [];
  const pkgs: Software = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+)-([^-]+-r\d+)$/);
    if (m?.[1]) pkgs.push({ name: m[1], version: m[2], source: "apk" });
    else pkgs.push({ name: line, source: "apk" });
  }
  return pkgs;
}

/** Auto-detect the package manager (dpkg → rpm → apk) and list installed packages, capped. */
export async function collectSoftware(warn: Warn = NO_WARN): Promise<Software | undefined> {
  let pkgs: Software = [];
  if (Bun.which("dpkg-query")) {
    pkgs = parseTabbed(
      await run(["dpkg-query", "-W", "-f=${Package}\\t${Version}\\n"], COLLECT_TIMEOUT_MS, warn),
      "dpkg",
    );
  } else if (Bun.which("rpm")) {
    pkgs = parseTabbed(
      await run(["rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\n"], COLLECT_TIMEOUT_MS, warn),
      "rpm",
    );
  } else if (Bun.which("apk")) {
    pkgs = parseApk(await run(["apk", "info", "-v"], COLLECT_TIMEOUT_MS, warn));
  } else {
    warn("software: no supported package manager (dpkg/rpm/apk) — installed list omitted");
  }
  return pkgs.length ? pkgs.slice(0, SOFTWARE_CAP) : undefined;
}

/** The contract's caps on `diagnostics.warnings` — mirrored here so the agent never invalidates itself. */
const WARNINGS_MAX = 50;
const WARNING_LENGTH_MAX = 300;

/**
 * The report's `diagnostics` block (#1138). ALWAYS emitted, even on a flawless run: `privileged` is
 * the answer to "why is web-03's serial column empty?", and it is only useful if it is there on every
 * report rather than only the unhappy ones. `warnings` is bounded to exactly what the contract accepts
 * — the agent validates its own report before POSTing, so an over-long diagnostic would turn a note
 * about a degraded fact into a total failure to report, which is precisely backwards.
 */
export function buildDiagnostics(
  warnings: readonly string[],
  privileged: boolean,
  durationMs: number,
): NonNullable<AgentReport["diagnostics"]> {
  const bounded = warnings.slice(0, WARNINGS_MAX).map((w) => w.slice(0, WARNING_LENGTH_MAX));
  return {
    ...(bounded.length ? { warnings: bounded } : {}),
    privileged,
    durationMs,
  };
}

/** Gather the full `host` block of an AgentReport (hostname is the only guaranteed field). */
export async function collectHost(warn: Warn = NO_WARN): Promise<Host> {
  const [osRelease, kernel, cpuinfo, meminfo, procStat, chassisType, smbiosUuid] =
    await Promise.all([
      readText("/etc/os-release"),
      readText("/proc/sys/kernel/osrelease"),
      readText("/proc/cpuinfo"),
      readText("/proc/meminfo"),
      readText("/proc/stat"),
      readText("/sys/class/dmi/id/chassis_type"),
      // Root-readable only (mode 0400) — unprivileged runs simply omit this identifier.
      readText("/sys/class/dmi/id/product_uuid"),
    ]);
  const [disks, nics, hardware, virtualization, machineId] = await Promise.all([
    collectDisks(warn),
    collectNics(warn),
    collectHardware(warn),
    collectVirtualization(warn),
    readMachineId(),
  ]);

  const host: Host = { hostname: osHostname() || "unknown" };
  const cpu = collectCpu(cpuinfo);
  const memoryBytes = collectMemoryBytes(meminfo);
  const bootedAt = parseBootedAt(procStat);
  // The MAC of the first physical NIC (a virtual one is regenerated per boot, so it identifies
  // nothing); falls back to the first NIC when /sys could not tell us which is which.
  const macNic = nics?.find((n) => n.isVirtual === false && n.mac) ?? nics?.find((n) => n.mac);
  const identifiers = buildIdentifiers({
    machineId,
    smbiosUuid,
    serial: hardware?.serial,
    mac: macNic?.mac,
  });

  host.os = collectOs(osRelease, kernel);
  // `virtualization` may be absent (no probe); then chassis rests on SMBIOS alone.
  host.chassis = chassisFor(virtualization?.type ?? "none", chassisType);
  if (virtualization) host.virtualization = virtualization;
  if (identifiers) host.identifiers = identifiers;
  if (bootedAt !== undefined) host.bootedAt = bootedAt;
  if (cpu) host.cpu = cpu;
  if (memoryBytes !== undefined) host.memoryBytes = memoryBytes;
  if (disks) host.disks = disks;
  if (nics) host.nics = nics;
  if (hardware) host.hardware = hardware;
  return host;
}
