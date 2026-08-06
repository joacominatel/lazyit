/**
 * The OS-NEUTRAL half of host fact collection (ADR-0074 §7). Everything here is either a pure
 * mapper over facts a per-OS collector has already gathered, or a primitive (spawn, clean, warn)
 * that every collector needs and none of them should re-derive.
 *
 * It exists because #1144 added a SECOND collector. Before it, `collect.ts` was Linux and "the
 * collector" interchangeably, and the honest way to add Windows was not to grow that file with
 * `process.platform` branches — it was to name what is genuinely shared and let each OS own the
 * rest. Nothing in this file may read `/proc`, `/sys`, the Windows registry or CIM: if a function
 * here knows which OS it is on, it is in the wrong file.
 *
 * The BEST-EFFORT contract is unchanged and unconditional: a missing tool, missing file or missing
 * privilege is silently omitted, never fatal — a partial report is valid (ADR-0074 §2/§3).
 */
import {
  AGENT_CONTAINER_PORTS_MAX,
  AGENT_CONTAINERS_MAX,
  AGENT_WARNING_LENGTH_MAX,
  AGENT_WARNINGS_MAX,
  matchesAnyGlob,
  normalizeIdentifierValue,
  sanitizeIdentifierValue,
  type AgentChassis,
  type AgentPolicy,
  type AgentContainerPortProtocol,
  type AgentContainerState,
  type AgentReport,
} from "@lazyit/shared";

export type Host = AgentReport["host"];
export type Software = NonNullable<AgentReport["software"]>;
export type Nics = NonNullable<Host["nics"]>;
export type Identifiers = NonNullable<Host["identifiers"]>;
export type Containers = NonNullable<Host["containers"]>;
export type Disks = NonNullable<Host["disks"]>;
export type Hypervisor = NonNullable<Host["hypervisor"]>;
export type Guests = NonNullable<Host["guests"]>;

/**
 * What a hypervisor collector answers with (ADR-0095, #1217): the host FACET and the guest
 * inventory, travelling together because they degrade together. `hypervisor` present with `guests`
 * ABSENT is a real and load-bearing state — detection fired but enumeration failed — and it is
 * different from `guests: []` (enumeration ran and found none), which is what lets the server
 * retire vanished children only on positive evidence. The shape is OS-neutral; each collector
 * (`hypervisor-linux.ts`, `hypervisor-windows.ts`) fills it from its own platform.
 */
export interface HypervisorFacts {
  hypervisor?: Hypervisor;
  guests?: Guests;
}

/**
 * Where a degraded collector reports itself (#1138). A sink rather than a return value because a
 * warning is orthogonal to the fact: `run()` still returns `null`, every caller still degrades
 * exactly as before, and the note simply rides along to `diagnostics.warnings`.
 */
export type Warn = (message: string) => void;

/** A no-op sink, so every collector stays callable without threading diagnostics through. */
export const NO_WARN: Warn = () => {};

/**
 * What a per-OS collector answers with (#1144): the host block, and whether the process that
 * gathered it was PRIVILEGED.
 *
 * The privilege bit rides WITH the facts rather than being asked for separately because the two
 * OSes learn it at different moments. Linux knows it from `getuid()` before anything runs; Windows
 * learns it from the same PowerShell blob that carries every other fact, and re-asking would mean a
 * second process spawn to answer a question the first one already answered. `diagnostics.privileged`
 * is the operator's answer to "why is this row's serial empty?", so it has to be the privilege the
 * COLLECTION actually ran under, not one inferred afterwards.
 */
export interface HostFacts {
  host: Host;
  privileged: boolean;
}

// ── Policy filters (ADR-0074 §7 amendment, #1140) ─────────────────────────────────────────────────
//
// Three pure functions applied to facts the collector has ALREADY gathered. They only ever REMOVE:
// no policy field names a path to read, a command to run or a source to fetch, so nothing here can
// widen what this process touches — which is the entire security posture of the policy channel.
//
// Every removal that is a POLICY decision files a warning. An empty NIC list that looks identical
// whether the host has no interfaces, the collector failed, or an operator turned it off is exactly
// the diagnostic gap #1138's `diagnostics.warnings` exists to close, and a central config channel is
// the fastest new way to create it.

/** Drop the NICs a policy excludes, or the whole fact when the collector is turned off. */
export function applyNicPolicy(
  nics: Nics | undefined,
  policy: AgentPolicy,
  warn: Warn = NO_WARN,
): Nics | undefined {
  if (!policy.collect.nics) {
    warn("nics: disabled by agent policy — network interfaces omitted");
    return undefined;
  }
  if (nics === undefined) return undefined;
  const globs = policy.exclude.nicNames;
  if (globs.length === 0) return nics;
  // An EMPTY result is returned as `[]`, not folded to undefined: "the policy excluded them all" is
  // a positive answer, and the contract already distinguishes absent from empty everywhere else.
  return nics.filter((nic) => !matchesAnyGlob(globs, nic.name));
}

/** Drop the disks whose MOUNTPOINT a policy excludes, or the whole fact when disks are turned off. */
export function applyDiskPolicy(
  disks: Disks | undefined,
  policy: AgentPolicy,
  warn: Warn = NO_WARN,
): Disks | undefined {
  if (!policy.collect.disks) {
    warn("disks: disabled by agent policy — block devices omitted");
    return undefined;
  }
  if (disks === undefined) return undefined;
  const globs = policy.exclude.mountpoints;
  if (globs.length === 0) return disks;
  // A disk with no mountpoint is NEVER matched: an unmounted disk is still a disk, and comparing an
  // absent value against a glob would silently drop the spares and array members most worth seeing.
  // On Windows NO disk carries a mountpoint at all (a physical drive is not a mount point there),
  // so this rule is what keeps a `mountpoints` glob from quietly emptying every Windows host's disk
  // list — the glob simply never matches, which is the truthful outcome.
  return disks.filter(
    (disk) => disk.mountpoint === undefined || !matchesAnyGlob(globs, disk.mountpoint),
  );
}

/**
 * Filter, then cap, the installed-package list. ORDER MATTERS: the cap is spent on packages that
 * survived the filters, so excluding kernel churn actually buys room rather than being wasted on
 * entries that were going to be dropped anyway.
 *
 * It returns a LIST, always — never `undefined`. The two ways a report can carry no software at all
 * ("the collector could not enumerate" and "the policy says do not") are OUTCOMES, not filter results,
 * and #1142 made the difference between them load-bearing: one preserves the stored inventory and the
 * other clears it. They are decided in each OS's `collectSoftware`, where the information to tell them
 * apart actually exists. An EMPTY result here is a positive finding — the policy matched everything —
 * and stays `[]` so the server stores "no packages" rather than reading it as "we did not look".
 */
export function applySoftwarePolicy(
  software: Software,
  policy: AgentPolicy,
  warn: Warn = NO_WARN,
): Software {
  const { softwareNames } = policy.exclude;
  const sources = policy.softwareSources;
  const kept = software.filter((pkg) => {
    if (softwareNames.length && matchesAnyGlob(softwareNames, pkg.name)) return false;
    // An EMPTY list means "every source". A package the collector could not attribute cannot be
    // shown to satisfy a non-empty filter, so it is dropped rather than admitted on a guess.
    if (sources.length === 0) return true;
    return pkg.source !== undefined && (sources as readonly string[]).includes(pkg.source);
  });
  if (kept.length > policy.softwareMax) {
    warn(
      `software: truncated to the policy cap of ${policy.softwareMax} (${kept.length} packages matched)`,
    );
    return kept.slice(0, policy.softwareMax);
  }
  return kept;
}

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
 * systemd's RuntimeMaxSec (Task Scheduler's `ExecutionTimeLimit` on Windows), which reaps the whole
 * job if a child outlives us.
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

/**
 * How a collector spawns. Injectable so tests can drive the impure boundary without the platform's
 * tooling — the pattern `windows.ts` established (#1144) and the hypervisor collectors reuse.
 * The production value is always {@link run}.
 */
export type Exec = typeof run;

/** Drop undefined/null/empty-string values; return undefined if nothing survives (omit the key). */
export function clean<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/**
 * Read whatever a JSON producer gave us as a LIST (#1144).
 *
 * It exists because `ConvertTo-Json` is not reliably array-preserving for a SINGLE-element
 * collection, and this repo has no Windows host to settle exactly when — CI is Linux, the developers
 * are on macOS. So both shapes are accepted rather than one being assumed: a bare object is read as
 * a one-element list. The failure it prevents would only appear on the least-equipped machines in an
 * estate (exactly one disk, one NIC, one installed program), which is the worst possible place to
 * discover a data-loss bug.
 *
 * Anything that is neither an array nor an object — `null`, a number, a missing key — is an empty
 * list, on the same degrade-never-reject rule as everything else here.
 */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === "object") return [value as T];
  return [];
}

/** The identity facts this host can offer, whatever it happens to have. */
export interface IdentifierFacts {
  machineId?: string | null;
  /** `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` — the Windows analogue (#1144). */
  windowsMachineGuid?: string | null;
  smbiosUuid?: string | null;
  serial?: string | null;
  mac?: string | null;
}

/**
 * The corroborating identifier set (#1138) — evidence #1141 will use to recognise the SAME host after
 * a re-install or a NIC swap. `externalId` remains the primary dedup key (ADR-0074 §3: one host = one
 * node, forever); nothing here is a second key. Empty facts are omitted, and an empty SET omits the
 * whole array rather than shipping `[]` (a partial report says nothing, it does not say "none").
 *
 * Both OS-primary kinds are listed, and a host only ever has one of them: Linux fills `machineId`,
 * Windows fills `windowsMachineGuid`. Listing both here rather than in each collector is what keeps
 * the ORDER of the array stable across platforms, which matters because #1141 compares sets.
 */
export function buildIdentifiers(facts: IdentifierFacts): Identifiers | undefined {
  const kinds = [
    ["machine-id", facts.machineId],
    ["windows-machine-guid", facts.windowsMachineGuid],
    ["smbios-uuid", facts.smbiosUuid],
    ["serial", facts.serial],
    ["mac", facts.mac],
  ] as const;
  const identifiers: Identifiers = [];
  for (const [kind, raw] of kinds) {
    // Canonicalise AND sanitize HERE as well as at the schema, so what the agent prints locally and
    // what the server stores are the same string — the contract owns both rules, this applies them
    // early. Sanitizing matters more than normalising: an OEM placeholder like `Default string` is
    // shared by every unflashed board of its model, so shipping it would let #1141 corroborate two
    // unrelated hosts into one. An identifier that sanitizes to nothing is OMITTED, never emitted
    // with an empty value.
    const value = sanitizeIdentifierValue(kind, raw ?? "")?.slice(0, 200);
    if (value) identifiers.push({ kind, value });
  }
  return identifiers.length ? identifiers : undefined;
}

/**
 * ONE canonical wire spelling for a NIC's hardware address (#1169): **lower-case, colon-separated**.
 *
 * WHY IT LIVES HERE AND NOT IN EITHER COLLECTOR. `nics[].mac` used to carry whatever its reader
 * produced — WMI hands Windows `AA:BB:CC:DD:EE:01`, `ip -j addr` hands Linux `aa:bb:cc:dd:ee:01` —
 * so one physical address reached the server spelled two ways depending on the reporting OS, and any
 * future consumer that GROUPS by it (a fleet view, a "which host owns this address?" lookup, a
 * fact-change diff) would get a false negative on every Windows row. Two copies of the rule would be
 * two chances to drift; one helper both collectors call is what makes the agreement structural.
 *
 * The rule is NOT re-invented here either: it is the contract's own
 * {@link normalizeIdentifierValue}, which has canonicalised `identifiers[].value` since #1138 — so
 * the NIC fact and the `mac` identifier derived from it cannot disagree inside one report, which is
 * precisely the inconsistency #1169 was filed for.
 *
 * SANITIZATION IS DELIBERATELY NOT APPLIED. `sanitizeIdentifierValue` additionally DROPS junk (an
 * all-zero address, an OEM placeholder), and that is right for EVIDENCE — two unrelated boards
 * reporting `00:00:00:00:00:00` must never corroborate into one host. It is wrong for a FACT: an
 * interface really does have that address, and an operator reading the NIC list should see what the
 * host reports. The identity path keeps its own guard (`selectPrimaryMac` skips the zero MAC), so
 * nothing is loosened by reporting it here.
 *
 * Tolerant, per the best-effort contract: a value that is not a recognisable MAC comes back
 * lower-cased but otherwise untouched rather than regrouped into a fiction, and a blank one is
 * `undefined` so the caller OMITS the key instead of shipping an empty string.
 */
export function canonicalMac(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeIdentifierValue("mac", trimmed) || undefined;
}

/**
 * SMBIOS chassis type → the contract's chassis vocabulary (DMTF DSP0134 §7.4.1). Only the codes with
 * an unambiguous meaning are mapped; everything else (Other, Unknown, Docking Station, Peripheral, …)
 * stays `unknown`, because a wrong classification is worse than none — #1139 infers `kind` from
 * this field, and "unknown" leaves the human's call intact where a guess would silently pre-empt it.
 *
 * Shared across OSes because the TABLE is the DMTF's, not Linux's: `/sys/class/dmi/id/chassis_type`
 * and `Win32_SystemEnclosure.ChassisTypes` are two readers of the same SMBIOS field. The RULE for
 * combining it with a virtualization probe is NOT shared — see `chassisFor` (Linux) and
 * `windowsChassis` (Windows), which differ for reasons documented at each.
 */
export const SMBIOS_CHASSIS: Record<number, AgentChassis> = {
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

/** One element of the runtime's `GET /containers/json`, in its own PascalCase spelling. */
interface DockerContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[];
}

/** The transports the contract enumerates, as a runtime set (the enum is erased at compile time). */
export const CONTAINER_PORT_PROTOCOLS = new Set<string>(["tcp", "udp", "sctp"]);

/** The container states the contract enumerates, as a runtime set (same erasure, same reason). */
const CONTAINER_STATES = new Set<string>([
  "running",
  "created",
  "restarting",
  "paused",
  "exited",
  "removing",
  "dead",
  "unknown",
]);

/**
 * Map one runtime state onto the contract's vocabulary — anything unrecognised becomes `unknown`,
 * mirroring `mapVirtualizationType`. The server's schema applies the same rule, so this is
 * belt-and-braces rather than the only guard; what it buys is that the agent's own `--once` output
 * and the stored fact read identically.
 */
export function mapContainerState(raw: string): AgentContainerState {
  const value = raw.trim().toLowerCase();
  return CONTAINER_STATES.has(value) ? (value as AgentContainerState) : "unknown";
}

/**
 * Parse a container runtime's `GET /containers/json` body into the contract's `containers` shape
 * (#1139). Pure and separately exported so the mapping is unit-testable on a machine with no
 * container runtime at all — which is every CI runner this repo has.
 *
 * `null` in, `undefined` out — and the same for a body that is not a JSON ARRAY. The distinction is
 * load-bearing all the way to the server: an ABSENT `containers` key means "the agent never learned
 * anything", so the server touches the child nodes it already has, while `[]` means "the probe ran
 * and this host runs none", which retires them. A 404 page or a `{"message":"permission denied"}`
 * error object is the first case, not the second — reading either as "no containers" would let a
 * momentarily-unreachable socket wipe a host's whole container topology.
 *
 * The container ID is truncated to the 12-char short form `docker ps` prints: it rides as
 * corroborating evidence, never as the identity key (that is the NAME — see `containerExternalId`),
 * so the full 64-char digest would be noise on a fact nothing compares.
 */
export function parseDockerContainers(body: string | null): Containers | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const containers: Containers = [];
  for (const raw of parsed as DockerContainer[]) {
    // The runtime prefixes every name with `/`; the operator's name is what follows it. A container
    // with several names (legacy links) reports the first, which is the one `docker ps` shows.
    const name = raw?.Names?.[0]?.replace(/^\/+/, "").trim();
    if (!name) continue;
    const ports = (raw.Ports ?? [])
      .filter((p) => Number.isInteger(p?.PrivatePort))
      .slice(0, AGENT_CONTAINER_PORTS_MAX)
      .map((p) => ({
        containerPort: p.PrivatePort as number,
        ...(Number.isInteger(p.PublicPort) ? { hostPort: p.PublicPort } : {}),
        ...(p.IP?.trim() ? { hostIp: p.IP.trim() } : {}),
        ...(p.Type && CONTAINER_PORT_PROTOCOLS.has(p.Type)
          ? { protocol: p.Type as AgentContainerPortProtocol }
          : {}),
      }));
    containers.push({
      name: name.slice(0, 200),
      ...(raw.Id?.trim() ? { id: raw.Id.trim().slice(0, 12) } : {}),
      ...(raw.Image?.trim() ? { image: raw.Image.trim() } : {}),
      ...(raw.ImageID?.trim() ? { imageDigest: raw.ImageID.trim() } : {}),
      ...(raw.State?.trim() ? { state: mapContainerState(raw.State) } : {}),
      ...(ports.length ? { ports } : {}),
    });
    if (containers.length >= AGENT_CONTAINERS_MAX) break;
  }
  return containers;
}

/** The wire contract's own `software` array max, kept as a backstop under every policy cap. */
export const SOFTWARE_CAP = 5000; // matches AgentReportSchema's software array max

/**
 * The report's `diagnostics` block (#1138). ALWAYS emitted, even on a flawless run: `privileged` is
 * the answer to "why is web-03's serial column empty?", and it is only useful if it is there on every
 * report rather than only the unhappy ones. `warnings` is bounded using the CONTRACT's own constants
 * (the server truncates rather than rejecting, but the agent should not make it do that work) — a note
 * about a degraded fact must never grow into a reason the report is worse.
 */
export function buildDiagnostics(
  warnings: readonly string[],
  privileged: boolean,
  durationMs: number,
): NonNullable<AgentReport["diagnostics"]> {
  const bounded = warnings
    .slice(0, AGENT_WARNINGS_MAX)
    .map((w) => w.slice(0, AGENT_WARNING_LENGTH_MAX));
  return {
    ...(bounded.length ? { warnings: bounded } : {}),
    privileged,
    durationMs,
  };
}
