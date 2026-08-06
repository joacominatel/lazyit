/**
 * Linux hypervisor detection + guest inventory (ADR-0095, #1217). The one collector here that reads
 * a platform's OWN control surface — `pvesh` on Proxmox, `virsh` on libvirt — and it stays inside
 * ADR-0074 §1's "self only" scope for the same reason the container probe does (#1139): it is the
 * local hypervisor's own list of what it is executing, read as root on the box itself. Never a
 * network scan, never a remote API, never a credential.
 *
 * DETECTION RE-RUNS ON EVERY TICK, exactly like the Docker socket probe: install PVE (or start
 * libvirtd) a month after the agent, and the next report just has guests — no re-install, no state.
 * Signals are evaluated cheapest-and-strongest first, most-specific-wins (ADR-0095 §2 precedence:
 * Proxmox > XCP-ng > libvirt): a PVE node is also Debian+KVM, and `virsh` on PVE sees NOTHING
 * (Proxmox does not use libvirt), so the platform slot goes to the most specific match only.
 *
 * ABSENT ≠ EMPTY, and it is load-bearing all the way to the server: `guests` is only ever sent when
 * enumeration SUCCEEDED — `[]` means "the probe ran and this host runs none", which retires the
 * server's child nodes. A probe that fails AFTER detection fired degrades to the hypervisor facet
 * plus a warning with NO `guests` key, so a wedged `pvesh` can never masquerade as an empty estate.
 *
 * A host with no hypervisor signal at all is SILENT — no facet, no warning. That is the
 * overwhelmingly common case, and a warning there would put a line in the majority of the estate's
 * reports until operators learned to ignore the field (the containers-probe rule, verbatim).
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { AGENT_GUESTS_MAX, AGENT_POLICY_DEFAULT, type AgentPolicy } from "@lazyit/shared";
import {
  canonicalMac,
  COLLECT_TIMEOUT_MS,
  NO_WARN,
  run,
  type Exec,
  type Guests,
  type HypervisorFacts,
  type Warn,
} from "./shared";

type Guest = Guests[number];
type GuestState = NonNullable<Guest["state"]>;

/**
 * The impure probes, injectable as one bag so the tests can script a Proxmox node, a libvirt host
 * or a dom0 from fixtures (the `windows.ts` Exec pattern, widened to files and PATH lookups).
 *
 * `pathExists` is stat-based ON PURPOSE, not `Bun.file().exists()`: that helper answers `false`
 * for anything that is not a regular file — `/dev/kvm` is a character device and the libvirt
 * sockets are unix sockets, exactly the trap that silently disabled the container collector once
 * (see `collectContainers` in `linux.ts`).
 */
export interface LinuxHypervisorDeps {
  readText(path: string): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  which(name: string): string | null;
  exec: Exec;
}

const DEFAULT_DEPS: LinuxHypervisorDeps = {
  readText: async (path) => {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
  pathExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  which: (name) => Bun.which(name),
  exec: run,
};

/** Where pmxcfs mounts the cluster filesystem — the Proxmox detection anchor. */
export const PVE_DIR = "/etc/pve";

/**
 * The libvirt daemon's local sockets: the monolithic `libvirtd` one and the modular `virtqemud`
 * one (Fedora/RHEL ship the split daemons by default since 9). Either present means the daemon is
 * reachable without shelling out to systemctl.
 */
export const LIBVIRT_SOCKETS = [
  "/var/run/libvirt/libvirt-sock",
  "/var/run/libvirt/virtqemud-sock",
] as const;

const KVM_DEVICE = "/dev/kvm";
const XENSOURCE_INVENTORY = "/etc/xensource-inventory";
const XEN_CAPABILITIES = "/proc/xen/capabilities";

/**
 * Is `/etc/pve` a MOUNTED fuse filesystem right now? Read from `/proc/mounts` (fields:
 * `device mountpoint fstype options …`), never by shelling out and never by `test -d`: a dead or
 * removed pmxcfs leaves the plain directory behind, and detection has to mean "the cluster fs is
 * ALIVE", not "a Proxmox install once existed here".
 */
export function isPveFuseMounted(procMounts: string | null): boolean {
  if (!procMounts) return false;
  for (const line of procMounts.split("\n")) {
    const [, mountpoint, fstype] = line.split(" ");
    if (mountpoint === PVE_DIR && (fstype === "fuse" || fstype?.startsWith("fuse."))) return true;
  }
  return false;
}

/**
 * The PVE node name from `readlink -f /etc/pve/local` — AUTHORITATIVE, never the hostname (the
 * hostname-vs-node-name mismatch is telegraf's documented footgun, ADR-0095 §3). The resolved
 * target is `/etc/pve/nodes/<name>`; a basename of `local` means readlink could not resolve the
 * link, and anything outside the safe charset is rejected rather than embedded in a pvesh path.
 */
export function pveNodeName(readlinkOut: string | null): string | undefined {
  const target = readlinkOut?.trim();
  if (!target) return undefined;
  const name = basename(target);
  if (!name || name === "local" || !/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  return name;
}

/** The states PVE reports that the contract enumerates; anything else folds to `other`. */
const PVE_STATES = new Set<GuestState>(["running", "stopped", "paused", "suspended"]);

/** One guest as the qemu/lxc LIST knows it — enough to ship even when its config read fails. */
export interface PveListRow {
  vmid: string;
  name: string;
  state?: GuestState;
  memoryBytes?: number;
}

/**
 * Parse a `pvesh get /nodes/<node>/{qemu,lxc}` JSON list. `null`/non-array in, `undefined` out —
 * "enumeration FAILED", which the caller must never flatten into "no guests" (a pvesh error object
 * is valid JSON and must not read as an empty host). Rows without a usable vmid are dropped; a row
 * with no name falls back to the vmid so the schema's ref+name filter keeps the guest.
 */
export function parsePveGuestList(json: string | null): PveListRow[] | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const rows: PveListRow[] = [];
  for (const raw of parsed as { vmid?: unknown; name?: unknown; status?: unknown; maxmem?: unknown }[]) {
    const vmid = pveVmid(raw?.vmid);
    if (!vmid) continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : vmid;
    const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : undefined;
    const maxmem = Number(raw.maxmem);
    rows.push({
      vmid,
      name,
      ...(status ? { state: PVE_STATES.has(status as GuestState) ? (status as GuestState) : "other" } : {}),
      ...(Number.isFinite(maxmem) && maxmem > 0 ? { memoryBytes: maxmem } : {}),
    });
  }
  return rows;
}

/** A VMID as pvesh reports it (number) or as a defensive string of digits; anything else is junk. */
function pveVmid(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return raw.trim();
  return undefined;
}

/** What one guest's config contributes beyond its list row — identity evidence, mostly. */
export interface PveConfigFacts {
  smbiosUuid?: string;
  macs?: string[];
  cores?: number;
  osHint?: string;
}

/** Any EUI-48 in a config value — qemu spells it `virtio=BC:…`, lxc `hwaddr=BC:…`; the SHAPE is the constant. */
const MAC_IN_VALUE = /[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}/g;

/**
 * Parse one guest's `pvesh get …/config` JSON. `undefined` means the fetch/parse failed — the
 * caller still ships the guest from its list row, minus the identity evidence, because a wedged
 * config read must cost FACTS and never the guest. The `smbios1` value is a comma-separated
 * key=value string; only its `uuid=` field matters here (QEMU exposes exactly that value in-guest
 * as `product_uuid`, which is the §6 identity join). MACs are extracted from every `netN` value by
 * shape rather than by key name, which is what makes one parser serve qemu and lxc configs alike.
 */
export function parsePveConfig(json: string | null): PveConfigFacts | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const config = parsed as Record<string, unknown>;

  const out: PveConfigFacts = {};
  if (typeof config.smbios1 === "string") {
    const uuid = config.smbios1.match(/(?:^|,)uuid=([0-9A-Fa-f-]{8,64})/)?.[1]?.toLowerCase();
    if (uuid) out.smbiosUuid = uuid;
  }
  const macs: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/.test(key) || typeof value !== "string") continue;
    for (const raw of value.match(MAC_IN_VALUE) ?? []) {
      const mac = canonicalMac(raw);
      if (mac && !macs.includes(mac)) macs.push(mac);
    }
  }
  if (macs.length) out.macs = macs;
  const cores = Number(config.cores);
  if (Number.isInteger(cores) && cores > 0) out.cores = cores;
  if (typeof config.ostype === "string" && config.ostype.trim()) out.osHint = config.ostype.trim();
  return out;
}

/** The cluster's name from `pvesh get /cluster/status` — the row typed `cluster`; standalone nodes have none. */
export function parsePveClusterName(json: string | null): string | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const row of parsed as { type?: unknown; name?: unknown }[]) {
    if (row?.type === "cluster" && typeof row.name === "string" && row.name.trim()) {
      return row.name.trim();
    }
  }
  return undefined;
}

/** `pve-manager/8.2.4/<hash> (…)` → `8.2.4`. pveversion's first line has been this shape since PVE 4. */
export function parsePveVersion(out: string | null): string | undefined {
  return out?.match(/^pve-manager\/([^/\s]+)/)?.[1];
}

/**
 * One name per line, as every `virsh list --name` variant prints. `null` in, `undefined` out
 * (virsh FAILED); empty output is an EMPTY list (it ran and there are no domains) — the same
 * absent-vs-empty rule as everything else here.
 */
export function parseVirshNameList(out: string | null): string[] | undefined {
  if (out === null) return undefined;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** What one domain's XML contributes. The uuid doubles as ref AND smbiosUuid — QEMU exposes it in-guest. */
export interface VirshDomainFacts {
  uuid: string;
  cores?: number;
  memoryBytes?: number;
  macs?: string[];
}

/**
 * libvirt's `<memory unit=…>` multipliers (libvirt's own vocabulary: power-of-two for the i-forms
 * AND the bare single letters, power-of-ten for the B-forms). The documented default is KiB.
 */
const LIBVIRT_MEMORY_UNITS: Record<string, number> = {
  b: 1,
  bytes: 1,
  kb: 1000,
  k: 1024,
  kib: 1024,
  mb: 1000 ** 2,
  m: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  g: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  t: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * Parse one `virsh dumpxml` document DEFENSIVELY — regexes over the few elements the contract has a
 * home for, no XML dependency (virsh has no JSON; dumpxml is its only machine-stable output, per
 * the ADR, and the elements read here have carried this exact shape since libvirt 1.x). A document
 * with no `<uuid>` is `undefined`: the uuid is the guest's stable ref, and a guest without one has
 * no identity worth minting a child node for — the caller drops THAT domain, never the collection.
 */
export function parseVirshDomainXml(xml: string | null): VirshDomainFacts | undefined {
  if (!xml) return undefined;
  const uuid = xml.match(/<uuid>\s*([0-9A-Fa-f-]{36})\s*<\/uuid>/)?.[1]?.toLowerCase();
  if (!uuid) return undefined;
  const out: VirshDomainFacts = { uuid };

  const vcpu = Number(xml.match(/<vcpu[^>]*>\s*(\d+)\s*<\/vcpu>/)?.[1]);
  if (Number.isInteger(vcpu) && vcpu > 0) out.cores = vcpu;

  const memory = xml.match(/<memory(?:\s+unit=['"]([^'"]*)['"])?[^>]*>\s*(\d+)\s*<\/memory>/);
  if (memory?.[2]) {
    const multiplier = memory[1] === undefined ? 1024 : LIBVIRT_MEMORY_UNITS[memory[1].toLowerCase()];
    const bytes = multiplier === undefined ? Number.NaN : Number(memory[2]) * multiplier;
    if (Number.isFinite(bytes) && bytes > 0) out.memoryBytes = bytes;
  }

  const macs: string[] = [];
  for (const m of xml.matchAll(/<mac\s+address=['"]([0-9A-Fa-f:.-]+)['"]/g)) {
    const mac = canonicalMac(m[1]);
    if (mac && !macs.includes(mac)) macs.push(mac);
  }
  if (macs.length) out.macs = macs;
  return out;
}

/**
 * Detect, then collect. The policy gate lives HERE (like `collectSoftware`'s) rather than at the
 * call site, so "turned off" files its one warning and skips every probe in one tested place.
 */
export async function collectHypervisorLinux(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
  deps: LinuxHypervisorDeps = DEFAULT_DEPS,
): Promise<HypervisorFacts | undefined> {
  if (!policy.collect.hypervisor) {
    warn("hypervisor: disabled by agent policy — hypervisor and guest inventory omitted");
    return undefined;
  }

  // ── Proxmox: the priority platform, and the cheapest strong signal (one /proc read) ─────────────
  if (isPveFuseMounted(await deps.readText("/proc/mounts"))) {
    return collectProxmox(warn, deps);
  }

  // ── XCP-ng: detected, honestly NOT collected (ADR-0095 §2 — dom0 binary compat is untested) ────
  const xenCaps = await deps.readText(XEN_CAPABILITIES);
  if (xenCaps?.includes("control_d") && (await deps.pathExists(XENSOURCE_INVENTORY))) {
    warn("hypervisor: XCP-ng detected; guest collection not yet supported");
    return { hypervisor: { platform: "xcpng" } };
  }

  // ── libvirt/KVM: /dev/kvm alone means "capable", not "acting hypervisor" — all three parts ─────
  if (!(await deps.pathExists(KVM_DEVICE))) return undefined;
  if (!deps.which("virsh")) return undefined;
  let daemonUp = false;
  for (const socket of LIBVIRT_SOCKETS) {
    if (await deps.pathExists(socket)) {
      daemonUp = true;
      break;
    }
  }
  if (!daemonUp) {
    // Socket-activated daemons may have no socket ONLY when also inactive; ask systemd before
    // giving up. NO_WARN on purpose: "this box does not run libvirt" is not a degradation.
    daemonUp =
      (await deps.exec(["systemctl", "is-active", "--quiet", "libvirtd"], COLLECT_TIMEOUT_MS, NO_WARN)) !== null ||
      (await deps.exec(["systemctl", "is-active", "--quiet", "virtqemud"], COLLECT_TIMEOUT_MS, NO_WARN)) !== null;
  }
  if (!daemonUp) return undefined;
  return collectLibvirt(warn, deps);
}

// ── Proxmox collection ────────────────────────────────────────────────────────────────────────────

/** One pvesh read, budgeted like every other collector command. */
function pvesh(deps: LinuxHypervisorDeps, warn: Warn, path: string): Promise<string | null> {
  return deps.exec(["pvesh", "get", path, "--output-format", "json"], COLLECT_TIMEOUT_MS, warn);
}

async function collectProxmox(warn: Warn, deps: LinuxHypervisorDeps): Promise<HypervisorFacts> {
  // The facet's decoration is best-effort and SILENT on failure (NO_WARN): a facet without a
  // version is complete; only the guest path warrants warnings.
  const version = parsePveVersion(await deps.exec(["pveversion"], COLLECT_TIMEOUT_MS, NO_WARN));
  const clusterName = parsePveClusterName(await pvesh(deps, NO_WARN, "/cluster/status"));

  const node = pveNodeName(
    await deps.exec(["readlink", "-f", "/etc/pve/local"], COLLECT_TIMEOUT_MS, warn),
  );
  const hypervisor = {
    platform: "proxmox" as const,
    ...(version ? { version } : {}),
    ...(clusterName ? { clusterName } : {}),
    ...(node ? { nodeName: node } : {}),
  };
  if (!node) {
    warn(
      "hypervisor: Proxmox detected but the node name could not be resolved from /etc/pve/local — guest list omitted",
    );
    return { hypervisor };
  }

  // Each node reports ONLY its own guests (ADR-0095 §4): a guest's config lives under exactly one
  // nodes/<name>/ directory in pmxcfs, so a cluster of agent-carrying nodes has zero overlap by
  // construction. /cluster/resources is deliberately not used.
  const qemu = parsePveGuestList(await pvesh(deps, warn, `/nodes/${node}/qemu`));
  const lxc = parsePveGuestList(await pvesh(deps, warn, `/nodes/${node}/lxc`));
  if (qemu === undefined || lxc === undefined) {
    // EITHER list failing degrades the WHOLE guests key: shipping only the half that answered
    // would read as "the other half vanished" and falsely retire the server's children.
    warn("hypervisor: Proxmox detected but pvesh could not enumerate guests — guest list omitted");
    return { hypervisor };
  }

  // Cap BEFORE the config fetches, so a pathological host never pays for reads the schema drops.
  const rows: (PveListRow & { kind: "qemu" | "lxc" })[] = [
    ...qemu.map((row) => ({ ...row, kind: "qemu" as const })),
    ...lxc.map((row) => ({ ...row, kind: "lxc" as const })),
  ].slice(0, AGENT_GUESTS_MAX);

  const guests: Guests = [];
  let configMisses = 0;
  // SEQUENTIAL on purpose: N bounded reads inside the tick's budget beat N concurrent pvesh
  // processes hammering pmxcfs on the host least able to spare it.
  for (const row of rows) {
    const config = parsePveConfig(
      await pvesh(deps, warn, `/nodes/${node}/${row.kind}/${row.vmid}/config`),
    );
    if (config === undefined) configMisses += 1;
    guests.push({
      ref: row.vmid,
      name: row.name,
      kind: row.kind,
      ...(row.state ? { state: row.state } : {}),
      ...(row.memoryBytes !== undefined ? { memoryBytes: row.memoryBytes } : {}),
      ...(config?.smbiosUuid ? { smbiosUuid: config.smbiosUuid } : {}),
      ...(config?.macs ? { macs: config.macs } : {}),
      ...(config?.cores ? { cores: config.cores } : {}),
      ...(config?.osHint ? { osHint: config.osHint } : {}),
    });
  }
  if (configMisses) {
    warn(
      `hypervisor: ${configMisses} guest config${configMisses === 1 ? "" : "s"} could not be read — identity evidence omitted for ${configMisses === 1 ? "that guest" : "those guests"}`,
    );
  }
  return { hypervisor, guests };
}

// ── libvirt collection ────────────────────────────────────────────────────────────────────────────

/**
 * The connection URI is EXPLICIT (ADR-0095 §4): root's default can surprise on modular-daemon
 * distros, and the system instance is the only one whose guests are this host's estate.
 */
const VIRSH = ["virsh", "-c", "qemu:///system"] as const;

async function collectLibvirt(warn: Warn, deps: LinuxHypervisorDeps): Promise<HypervisorFacts> {
  const hypervisor = { platform: "libvirt" as const };
  const exec = (args: string[], sink: Warn = warn) =>
    deps.exec([...VIRSH, ...args], COLLECT_TIMEOUT_MS, sink);

  const names = parseVirshNameList(await exec(["list", "--all", "--name"]));
  if (names === undefined) {
    warn("hypervisor: libvirt detected but virsh could not enumerate domains — guest list omitted");
    return { hypervisor };
  }
  if (names.length === 0) return { hypervisor, guests: [] };

  // STATE comes from two more `--name` list calls filtered by state, not from `virsh list --all`'s
  // human table (the ADR forbids parsing it) and not from a per-domain `domstate` (which would
  // double the per-guest process count). Membership: running set → running, paused set → paused,
  // everything else → stopped — but ONLY when both filter queries answered: membership in a set
  // that could not be enumerated proves nothing, and inventing `stopped` for a running guest is
  // exactly the false fact the omission exists to avoid.
  const running = parseVirshNameList(await exec(["list", "--name", "--state-running"], NO_WARN));
  const paused = parseVirshNameList(await exec(["list", "--name", "--state-paused"], NO_WARN));
  const statesKnown = running !== undefined && paused !== undefined;
  const runningSet = new Set(running ?? []);
  const pausedSet = new Set(paused ?? []);

  const guests: Guests = [];
  let dropped = 0;
  for (const name of names.slice(0, AGENT_GUESTS_MAX)) {
    const facts = parseVirshDomainXml(await exec(["dumpxml", name]));
    if (!facts) {
      // Malformed or unreadable XML costs THAT domain, never the collection.
      dropped += 1;
      continue;
    }
    const state: GuestState | undefined = statesKnown
      ? runningSet.has(name)
        ? "running"
        : pausedSet.has(name)
          ? "paused"
          : "stopped"
      : undefined;
    guests.push({
      // The domain uuid is the platform's stable ref AND the SMBIOS UUID QEMU exposes in-guest —
      // one value, both roles, which is what makes the §6 identity join free on this platform.
      ref: facts.uuid,
      name,
      kind: "libvirt",
      ...(state ? { state } : {}),
      smbiosUuid: facts.uuid,
      ...(facts.macs ? { macs: facts.macs } : {}),
      ...(facts.cores ? { cores: facts.cores } : {}),
      ...(facts.memoryBytes !== undefined ? { memoryBytes: facts.memoryBytes } : {}),
    });
  }
  if (dropped) {
    warn(
      `hypervisor: ${dropped} libvirt domain${dropped === 1 ? "" : "s"} could not be read (dumpxml failed or carried no uuid) — dropped from this report`,
    );
  }
  return { hypervisor, guests };
}
