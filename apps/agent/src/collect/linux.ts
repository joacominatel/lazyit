/**
 * Linux host fact collection (ADR-0074 §7). Every fact is BEST-EFFORT: a missing tool, missing file
 * or missing privilege is silently omitted, never fatal — a partial report is valid (ADR-0074 §2/§3).
 * The only hard requirements are `hostname` (always available) and `/etc/machine-id` (the dedup key,
 * handled by the caller).
 *
 * Contract v2 (#1138) adds what this collector can honestly determine on Linux TODAY: the `os.family`
 * discriminator, the SMBIOS chassis type, the virtualization probe, corroborating identifiers, IPv6 +
 * virtual-interface flags on NICs, the boot instant, package-manager provenance — and `warnings`, the
 * one that changes what an operator can SEE. Everything else here degrades a failure to an omitted
 * fact, which leaves an empty column that looks identical whether the host lacks `dmidecode`, the
 * agent lacks root, or a collector hung. The warnings sink is where that difference survives.
 *
 * Since #1144 this file is ONE of two collectors (`windows.ts` is the other) behind the dispatcher in
 * `./index.ts`. Everything OS-neutral moved to `./shared.ts`; what is left reads `/proc`, `/sys` and
 * Linux tooling, and may assume it is running on Linux without checking.
 */
import { stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import {
  AGENT_POLICY_DEFAULT,
  selectPrimaryMac,
  type AgentChassis,
  type AgentPolicy,
  type AgentIpv6Scope,
  type AgentNicIpv6,
  type AgentVirtualizationType,
} from "@lazyit/shared";
import type { SoftwareCollection } from "../software-delta";
import { collectHypervisorLinux } from "./hypervisor-linux";
import {
  applyDiskPolicy,
  applyNicPolicy,
  applySoftwarePolicy,
  buildIdentifiers,
  canonicalMac,
  clean,
  COLLECT_TIMEOUT_MS,
  NO_WARN,
  parseDockerContainers,
  run,
  SMBIOS_CHASSIS,
  SOFTWARE_CAP,
  type Host,
  type HostFacts,
  type Nics,
  type Software,
  type Warn,
} from "./shared";

/** Read a file as text, or null if it does not exist / is unreadable. */
async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/**
 * Does a REGULAR FILE exist at this path? Used to tell a physical NIC from a virtual one, where both
 * probed paths (`/sys/class/net/<n>/type`, `.../device/uevent`) are ordinary sysfs files.
 *
 * REGULAR FILE is the whole caveat, and it is not obvious: `Bun.file(path).exists()` resolves `false`
 * for anything that is not a file — a directory, a device, and (verified on Bun 1.3.14) a unix SOCKET.
 * `collectContainers` gated on this helper and was therefore dead on every host on earth; it now
 * `stat`s the path itself. Do not reach for this function to test a non-file.
 */
async function exists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
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
 * The `os` block. `family` is stamped UNCONDITIONALLY (#1138) — this is the Linux collector, so the
 * answer is known even when `/etc/os-release` is unreadable, and every downstream consumer branches
 * on it. `build` carries `BUILD_ID` where the distro sets one (immutable/atomic images).
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
  // LOGICAL CPUs — each `processor :` line is a hyper-thread. This IS the wire semantic of
  // `host.cpu.cores` on every platform (#1191): the fleet was measured against this count first, so
  // the Windows collector aligned to it rather than the other way round.
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
 * What the host IS (#1138) — the virtualization probe WINS over SMBIOS, because a guest inherits its
 * hypervisor's synthetic board: DMI happily calls a KVM guest a "desktop" (chassis type 3), which is
 * exactly the misclassification #1139 must not inherit. Only a host detect-virt calls bare metal
 * falls through to its chassis code; an unrecognised (`other`) virtualization still means virtualized.
 *
 * `undefined` — the probe did not RUN — is `unknown`, not `none`. Those are different facts and the
 * contract has vocabulary for both. Reading a missing probe as a positive bare-metal finding meant
 * classifying the host from DMI it does not own: inside a container `/sys/class/dmi` exposes the
 * HOST's board, so a container on a distro without `systemd-detect-virt` reported `chassis: server`
 * with full confidence. #1139 infers `kind` from this field, and a wrong classification silently
 * pre-empts the human's call where `unknown` leaves it intact.
 *
 * That last paragraph is also why `windows.ts` does not reuse this function: the failure it guards
 * against is a Linux container reading the HOST's `/sys/class/dmi`, and the Windows collector has no
 * equivalent exposure — see `windowsChassis` there for the rule that replaces it.
 */
export function chassisFor(
  virtualization: AgentVirtualizationType | undefined,
  smbiosChassisType: string | null,
): AgentChassis {
  if (virtualization === undefined) return "unknown";
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
  if (!Bun.which("systemd-detect-virt")) {
    // Worth a note precisely because the consequence is invisible otherwise: without this probe the
    // host also reports `chassis: unknown`, and the operator would otherwise see two empty fields
    // with no way to tell a missing tool from a fact the agent chose not to guess.
    warn(
      "virtualization: systemd-detect-virt unavailable — virtualization omitted and chassis left unknown",
    );
    return undefined;
  }
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

/** One `addr_info` entry of `ip -j addr`, restricted to the fields the contract has a home for. */
interface IpAddrInfo {
  family?: string;
  local?: string;
  prefixlen?: number;
  scope?: string;
  temporary?: boolean;
  deprecated?: boolean;
  preferred_life_time?: number;
}

interface IpAddr {
  ifname?: string;
  address?: string;
  addr_info?: IpAddrInfo[];
}

/** iproute2's scope names, restricted to the contract's vocabulary (anything else is simply omitted). */
const IPV6_SCOPES = new Set<string>(["global", "site", "link", "host"]);

/**
 * One IPv6 address with the context that makes it CHOOSABLE (#1138). Reporting bare strings left the
 * server picking "the first non-`fe80:` entry", which on any modern desktop distro is an RFC 4941
 * privacy address — temporary by design, regenerated on a timer, and therefore the worst possible
 * value to pin a node's map entry to. `iproute2` already knows all of this; the collector just has to
 * carry it. `preferred_life_time: 0` is read as deprecated because iproute2 reports the spent lifetime
 * even on kernels/builds that do not also emit the boolean.
 */
function toNicIpv6(a: IpAddrInfo): AgentNicIpv6 | undefined {
  const address = a.local?.trim();
  if (!address) return undefined;
  const scope = a.scope && IPV6_SCOPES.has(a.scope) ? (a.scope as AgentIpv6Scope) : undefined;
  const deprecated = a.deprecated === true || a.preferred_life_time === 0;
  return {
    address,
    ...(Number.isInteger(a.prefixlen) ? { prefixLength: a.prefixlen } : {}),
    ...(scope ? { scope } : {}),
    ...(a.temporary === true ? { temporary: true } : {}),
    ...(deprecated ? { deprecated: true } : {}),
  };
}

/**
 * Parse `ip -j addr` into the contract's NIC shape (#1138). BOTH families now: v1 carried IPv4 only
 * while the shared `IpAddressSchema` had always accepted v6, so a v6-only host reported no address at
 * all. Link-local addresses are kept verbatim — the collector reports what the interface has, and the
 * server's promotion mapper (`primaryIpv6`) decides what is worth showing as the node's IP. Loopback
 * is dropped (it is never a host fact worth inventorying).
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
    const ipv6 = addresses
      .filter((a) => a.family === "inet6")
      .map(toNicIpv6)
      .filter((a): a is AgentNicIpv6 => a !== undefined);
    const nic: Nics[number] = { name };
    // CANONICALISED, not passed through (#1169). `ip -j addr` already answers in the canonical
    // spelling, so this changes nothing on a healthy host — it is here so the RULE, not the reader's
    // habit, is what the wire carries, and so Linux and Windows cannot drift apart again.
    const mac = canonicalMac(n.address);
    if (mac) nic.mac = mac;
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

/**
 * The container runtime's local API socket (#1139). Docker's default path, which Podman's
 * docker-compatible service is conventionally symlinked to — so one path covers both without the
 * agent having to know which runtime it is talking to.
 */
export const DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * The containers this host runs (#1139) — the only collector here that discovers something OTHER
 * than the host itself, which is what finally gives the topology graph an EDGE to draw.
 *
 * It stays inside ADR-0074 §1's "self only" scope: this is not network discovery, it is the local
 * runtime's own list of what it is executing, read over a local unix socket the agent either can
 * open or cannot. RUNNING containers only (the runtime's default, no `all=true`) — a `RUNS_ON` edge
 * describes what is executing, an exited one-shot job from six months ago has no relationship worth
 * drawing, and the node of a container that stops is not deleted but goes OFFLINE, which is a truer
 * answer than listing it forever.
 *
 * A host with no socket is the overwhelmingly common case and files NO warning: "this box does not
 * run Docker" is not a degradation, and warning on it would put a line in the majority of reports
 * until the operator learned to ignore the field. A socket that EXISTS but cannot be read is the
 * opposite — that is the "why is this host's container list empty?" question #1138's warnings exist
 * to answer — so it warns.
 *
 * The probe runs on EVERY tick and caches nothing, which is what makes "I registered this host, then
 * installed Docker a month later" simply work: the first tick after the socket appears reports the
 * containers, with no re-install and no state to clear. `windows.ts` preserves that property with a
 * different probe (#1144).
 */
export async function collectContainers(
  warn: Warn,
  socket = DOCKER_SOCKET,
): Promise<Host["containers"]> {
  // `stat`, NOT `Bun.file().exists()` — the latter is a REGULAR-FILE check and answers `false` for a
  // unix socket (verified on Bun 1.3.14), which silently disabled this entire collector on every
  // host. `node:fs/promises` is the exception the repo's Bun-first rule leaves room for: Bun exposes
  // no API that can tell a socket from a missing path. The ASYNC form, because `collectHost` fires
  // every collector concurrently and the sync one would park the whole event loop on a filesystem
  // call — the pathological-host failure mode #1133 exists to prevent.
  //
  // A throw here is the overwhelmingly common "this box does not run containers" case (ENOENT) or an
  // unsearchable parent, and so is a path holding something that is not a socket. All are SILENT:
  // warning would put a line in the majority of reports until operators learned to ignore the field.
  try {
    if (!(await stat(socket)).isSocket()) return undefined;
  } catch {
    return undefined;
  }
  let body: string;
  try {
    // `unix:` routes the request over the socket; the host part is ignored but must be present.
    const res = await fetch("http://localhost/containers/json", {
      unix: socket,
      signal: AbortSignal.timeout(COLLECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      warn(`containers: ${socket} answered ${res.status} — container list omitted`);
      return undefined;
    }
    body = await res.text();
  } catch {
    warn(`containers: ${socket} exists but could not be read — container list omitted`);
    return undefined;
  }
  const containers = parseDockerContainers(body);
  if (containers === undefined) {
    warn(`containers: ${socket} returned an unreadable list — container list omitted`);
  }
  return containers;
}

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

/**
 * Auto-detect the package manager (dpkg → rpm → apk) and list installed packages, capped.
 *
 * The POLICY is checked before anything is spawned (#1140): a host whose policy turns software
 * collection off must not pay for `dpkg-query` over 3,000 packages just to throw the result away.
 *
 * It answers with an OUTCOME, not a maybe-list (#1142). `disabled` and `unavailable` both send no
 * packages and mean opposite things to the server — the first clears the stored inventory, the second
 * keeps it — and this is the only place in the agent where the two are still distinguishable. A
 * collector that returned `undefined` for both would hand the server a question it cannot answer.
 */
export async function collectSoftware(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
): Promise<SoftwareCollection> {
  if (!policy.collect.software) {
    warn("software: disabled by agent policy — installed package list omitted");
    return { state: "disabled" };
  }
  let out: string | null = null;
  let pkgs: Software;
  if (Bun.which("dpkg-query")) {
    out = await run(["dpkg-query", "-W", "-f=${Package}\\t${Version}\\n"], COLLECT_TIMEOUT_MS, warn);
    pkgs = parseTabbed(out, "dpkg");
  } else if (Bun.which("rpm")) {
    out = await run(["rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\n"], COLLECT_TIMEOUT_MS, warn);
    pkgs = parseTabbed(out, "rpm");
  } else if (Bun.which("apk")) {
    out = await run(["apk", "info", "-v"], COLLECT_TIMEOUT_MS, warn);
    pkgs = parseApk(out);
  } else {
    warn("software: no supported package manager (dpkg/rpm/apk) — installed list omitted");
    return { state: "unavailable" };
  }
  // A null stdout is the manager FAILING (missing binary, non-zero exit, the #1133 timeout), which is
  // "we could not look" — never "this host has no packages". The two parsers both fold null into an
  // empty list, so the distinction has to be made here, before it is lost.
  if (out === null) return { state: "unavailable" };
  // SOFTWARE_CAP is the WIRE contract's own array max and stays as a backstop; the policy cap is
  // applied inside `applySoftwarePolicy` and is only ever equal to or lower than it.
  return { state: "reported", software: applySoftwarePolicy(pkgs.slice(0, SOFTWARE_CAP), policy, warn) };
}

/**
 * Gather the full `host` block of an AgentReport (hostname is the only guaranteed field), plus
 * whether this run was privileged (#1144 — see {@link HostFacts}).
 *
 * The POLICY (#1140) decides which collectors run at all and which facts survive. A collector that
 * is turned off is never SPAWNED, not merely filtered afterwards — turning `hardware` off has to
 * actually stop the agent shelling out to `dmidecode`, or the setting buys the operator nothing on
 * the host where they most likely reached for it (a box with a wedged BMC).
 *
 * Two identity consequences are worth stating rather than discovering: `hardware` off removes the
 * SERIAL and `nics` off removes the primary MAC, and those are the two burned-in facts #1141's clone
 * detection corroborates on. A host configured that way is still ingested — it simply cannot be told
 * apart from a clone of itself. Each disabled collector files a warning, so the reason is visible on
 * the node instead of being inferred from an empty column.
 */
export async function collectHost(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
): Promise<HostFacts> {
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
  const [rawDisks, rawNics, hardware, virtualization, machineId, containers, hypervisorFacts] =
    await Promise.all([
      policy.collect.disks ? collectDisks(warn) : undefined,
      policy.collect.nics ? collectNics(warn) : undefined,
      policy.collect.hardware ? collectHardware(warn) : undefined,
      collectVirtualization(warn),
      readMachineId(),
      policy.collect.containers ? collectContainers(warn) : undefined,
      // No ternary: the policy gate (and its one disabled-collector warning) lives inside the
      // collector, which is also where the per-platform detection re-runs every tick (ADR-0095).
      collectHypervisorLinux(warn, policy),
    ]);
  if (!policy.collect.hardware) {
    warn("hardware: disabled by agent policy — manufacturer/model/serial omitted");
  }
  if (!policy.collect.containers) {
    warn("containers: disabled by agent policy — container list omitted");
  }
  // The filters also carry the "disabled by policy" warning for their own fact, so a disabled
  // collector reads identically whether it was skipped here or filtered there.
  const disks = applyDiskPolicy(rawDisks, policy, warn);
  const nics = applyNicPolicy(rawNics, policy, warn);

  const host: Host = { hostname: osHostname() || "unknown" };
  const cpu = collectCpu(cpuinfo);
  const memoryBytes = collectMemoryBytes(meminfo);
  const bootedAt = parseBootedAt(procStat);
  // WHICH mac becomes the identifier is the contract's rule, not this collector's (#1138): it has to
  // be a property of the NIC SET, because "whichever `ip -j addr` listed first" is kernel ifindex
  // order and #1141 compares this value across reports.
  const identifiers = buildIdentifiers({
    machineId,
    smbiosUuid,
    serial: hardware?.serial,
    mac: selectPrimaryMac(nics),
  });

  host.os = collectOs(osRelease, kernel);
  // `virtualization` may be absent (the probe did not run). That is passed through as `undefined`,
  // NOT as `none`: the SMBIOS chassis code is only this host's fact once something confirmed it is
  // not a guest, and inside a container `/sys/class/dmi` is the host's, not ours.
  host.chassis = chassisFor(virtualization?.type, chassisType);
  if (virtualization) host.virtualization = virtualization;
  if (identifiers) host.identifiers = identifiers;
  // ABSENT (the probe could not run) and `[]` (it ran and found none) are different answers the
  // server acts on differently, so an empty list is REPORTED rather than omitted (#1139).
  if (containers !== undefined) host.containers = containers;
  // The hypervisor facet only exists on a positive detection; `guests` rides the same
  // absent-vs-empty rule as `containers` — enumeration that failed after detection fired ships
  // the facet WITH a warning and NO guests key (ADR-0095 §2/§3).
  if (hypervisorFacts?.hypervisor) host.hypervisor = hypervisorFacts.hypervisor;
  if (hypervisorFacts?.guests !== undefined) host.guests = hypervisorFacts.guests;
  if (bootedAt !== undefined) host.bootedAt = bootedAt;
  if (cpu) host.cpu = cpu;
  if (memoryBytes !== undefined) host.memoryBytes = memoryBytes;
  if (disks) host.disks = disks;
  if (nics) host.nics = nics;
  if (hardware) host.hardware = hardware;
  return { host, privileged: process.getuid?.() === 0 };
}
