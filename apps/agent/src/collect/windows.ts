/**
 * Windows host fact collection (ADR-0074 §7 amendment, issue #1144). The second collector behind the
 * dispatcher in `./index.ts`, and the one that makes the estate this product is sold into
 * addressable: a representative target is ~180 Windows endpoints and ~25 Windows Servers against
 * ~40 Linux boxes.
 *
 * ONE PowerShell CALL FOR THE WHOLE FACT SWEEP. Everything that needs CIM/WMI or the registry is
 * gathered by a single `powershell -NoProfile -NonInteractive -Command <script>` that emits ONE
 * compressed JSON document; every function in this file below that is a pure mapper over it. Two
 * reasons, and the second is the one that matters: a ~400 ms interpreter start once per reporting
 * interval is free, and a single impure boundary is the only shape this repo can actually TEST from a
 * Linux CI runner and a macOS laptop. The mappers are covered by `windows.test.ts`; the script's own
 * OUTPUT is not covered by anything here, and the only way to see it is `lazyit-agent show` on a real
 * Windows host — which the Manual documents as the diagnostic for "what would this machine report?".
 *
 * WHAT A TICK ACTUALLY COSTS, precisely, because "one call per tick" was not true and is worth
 * stating exactly: {@link readMachineGuid} makes a SECOND, much smaller PowerShell call for the dedup
 * key, and it has to, because `index.ts` needs that key BEFORE the cadence gate — folding it into the
 * sweep would make a tick that reports nothing pay for the full CIM walk. Both calls are memoized per
 * process, so a REPORTING tick is two `powershell.exe` starts and a tick that is not due is one.
 *
 * TWO PROHIBITIONS, both absolute:
 *
 *  - **Never `Win32_Product`.** Enumerating that class makes the Windows Installer run a consistency
 *    check that RECONFIGURES every installed MSI package on the box. It floods the event log, takes
 *    minutes, and has broken more fleets than malware. Installed software comes from the Uninstall
 *    registry keys instead — which is also where the truth actually lives, since anything not
 *    installed by MSI is invisible to `Win32_Product` anyway.
 *  - **Never `wmic.exe`.** Deprecated for years and REMOVED in Windows 11 24H2 and Server 2025, so an
 *    agent that shelled out to it would work on the estate's old machines and silently stop working
 *    on its new ones. `Get-CimInstance` is the supported reader and it is what this uses.
 *
 * PRIVILEGE degrades, it does not fail — exactly as the Linux collector does without root. The
 * Scheduled Task registered by `install.ps1` runs as `NT AUTHORITY\SYSTEM`, which holds local WMI/CIM
 * rights with NO credential stored anywhere on the host; that is precisely why a domain service
 * account is refused. Run by hand as an ordinary user, the same script simply returns less, and
 * `diagnostics.privileged` says so.
 */
import { hostname as osHostname } from "node:os";
import {
  AGENT_POLICY_DEFAULT,
  selectPrimaryMac,
  type AgentChassis,
  type AgentContainerPortProtocol,
  type AgentIpv6Scope,
  type AgentNicIpv6,
  type AgentPolicy,
  type AgentVirtualizationType,
} from "@lazyit/shared";
import type { SoftwareCollection } from "../software-delta";
import {
  applyDiskPolicy,
  applyNicPolicy,
  applySoftwarePolicy,
  asArray,
  buildIdentifiers,
  clean,
  CONTAINER_PORT_PROTOCOLS,
  mapContainerState,
  NO_WARN,
  run,
  SMBIOS_CHASSIS,
  SOFTWARE_CAP,
  type Containers,
  type Disks,
  type Host,
  type HostFacts,
  type Nics,
  type Software,
  type Warn,
} from "./shared";

// ── The single PowerShell call ────────────────────────────────────────────────────────────────────

/**
 * The interpreter. `powershell.exe` (Windows PowerShell 5.1) and NOT `pwsh`, because 5.1 ships with
 * every supported Windows and PowerShell 7 does not — the agent is a single self-contained binary
 * precisely so the host needs nothing installed, and reaching for an optional interpreter would give
 * that away for no gain. `-NoProfile` keeps an operator's `$PROFILE` from changing what the agent
 * collects; `-NonInteractive` makes any prompt an error instead of a hang under SYSTEM.
 */
const POWERSHELL = "powershell.exe";

/**
 * The collection script, as ONE line.
 *
 * EVERY string literal in it is SINGLE-quoted, deliberately. The script travels as one argv element
 * and Windows has no argv — the OS hands the child a command LINE, which every runtime re-quotes on
 * the way out and PowerShell re-parses on the way in. A double quote anywhere in here would put the
 * correctness of the whole collector at the mercy of that round trip. `-EncodedCommand` would remove
 * the hazard entirely and is rejected for a different one: base64'd PowerShell is a signature EDR
 * products alert on, and an unsigned inventory agent has no budget for looking like malware.
 *
 * `$ErrorActionPreference='SilentlyContinue'` is the best-effort contract expressed in PowerShell: a
 * class that does not exist on this SKU, a registry hive that is absent on 32-bit Windows, or a
 * namespace an unprivileged caller cannot open leaves its key null instead of aborting the document.
 *
 * SILENTLY-CONTINUE IS NOT SILENTLY-FORGET (#1138). The errors it swallows still land in `$Error`,
 * and they are the answer to "why is this host's serial empty?" — so the document carries them out
 * as `errors[]` and {@link buildWindowsHost} files each one as a warning. Without that, the one
 * Windows call was the only collector in this agent that could degrade with nothing to show for it,
 * while every Linux probe warns. `$Error` is CLEARED first so nothing from before the sweep can be
 * attributed to it, and `errors` is the LAST key because a hashtable literal is evaluated in written
 * order — which is the only reason it sees what the earlier keys raised.
 */
export const WINDOWS_FACTS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$ProgressPreference='SilentlyContinue'",
  "$Error.Clear()",
  "$os=Get-CimInstance -ClassName Win32_OperatingSystem",
  "$cs=Get-CimInstance -ClassName Win32_ComputerSystem",
  // An ABSOLUTE instant, round-trip formatted HERE rather than left to ConvertTo-Json, whose
  // DateTime rendering differs between Windows PowerShell 5.1 and PowerShell 7. Formatting it in the
  // script makes the wire value the same string whichever interpreter answered, which is worth more
  // than knowing exactly what each one would otherwise have produced.
  "$boot=$null;if($os -and $os.LastBootUpTime){$boot=$os.LastBootUpTime.ToUniversalTime().ToString('o')}",
  // The primary dedup key. Read from the 64-bit view (this process is the x64 build), which is the
  // view `sysprep /generalize` regenerates.
  "$mg=$null;try{$mg=(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid}catch{}",
  // SYSTEM is a member of the Administrators role, so the scheduled run reports `true` and a
  // hand-run under an ordinary account reports `false` — which is exactly what `privileged` means.
  "$el=$false;try{$el=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{}",
  "[pscustomobject]@{" +
    // BuildNumber, not just Version: 'Windows 11, version 10.0' tells an operator nothing, and the
    // build is how anyone actually names a Windows release (26100 = 24H2).
    "os=[pscustomobject]@{Caption=$os.Caption;Version=$os.Version;BuildNumber=$os.BuildNumber;LastBootUpTime=$boot};" +
    "cs=$cs|Select-Object TotalPhysicalMemory,Manufacturer,Model,Domain,PartOfDomain,DNSHostName;" +
    "cpu=@(Get-CimInstance -ClassName Win32_Processor|Select-Object Name,NumberOfCores,NumberOfLogicalProcessors);" +
    "bios=Get-CimInstance -ClassName Win32_BIOS|Select-Object SerialNumber;" +
    "csp=Get-CimInstance -ClassName Win32_ComputerSystemProduct|Select-Object UUID;" +
    "enclosure=Get-CimInstance -ClassName Win32_SystemEnclosure|Select-Object -First 1 ChassisTypes;" +
    "disks=@(Get-CimInstance -ClassName Win32_DiskDrive|Select-Object DeviceID,Model,Size);" +
    // The fallback for hosts where Win32_DiskDrive enumerates nothing (Storage Spaces, some
    // paravirtual controllers). Its namespace may be missing on old SKUs; the error is swallowed.
    "physicalDisks=@(Get-CimInstance -Namespace 'root\\Microsoft\\Windows\\Storage' -ClassName MSFT_PhysicalDisk|Select-Object FriendlyName,Size);" +
    // `MACAddress IS NOT NULL` is what separates real interfaces from the several dozen WAN Miniport
    // and tunnelling pseudo-adapters every Windows install carries. A DISCONNECTED physical NIC still
    // has one, and its burned-in address is identity evidence, so it is deliberately kept.
    "adapters=@(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter 'MACAddress IS NOT NULL'|Select-Object Index,NetConnectionID,MACAddress,PhysicalAdapter);" +
    "adapterConfigs=@(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter 'MACAddress IS NOT NULL'|Select-Object Index,MACAddress,IPAddress,IPSubnet);" +
    // BOTH MACHINE-WIDE uninstall hives. Half of a real inventory lives in WOW6432Node and missing
    // it is the #1 thing homegrown inventory scripts get wrong. Per-USER installs live under HKCU /
    // HKU\<sid> and are NOT read — see `parseWindowsSoftware` for why that is its own piece of work.
    // Nothing is filtered here; the DisplayName / SystemComponent rules live in the tested mapper.
    "software=@(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'|Select-Object DisplayName,DisplayVersion,SystemComponent);" +
    "machineGuid=$mg;" +
    "elevated=$el;" +
    // LAST, deliberately — see the note above. `Activity` is the cmdlet that failed, which is what
    // turns a bare "Access is denied." into something an operator can act on. Bounded at 10: a
    // pathological host must degrade into a report, not into an error log.
    "errors=@($Error|Select-Object -First 10|ForEach-Object{('{0}: {1}' -f $_.CategoryInfo.Activity,$_.Exception.Message)})" +
    "}|ConvertTo-Json -Compress -Depth 4",
].join(";");

/**
 * Budget for the one PowerShell call, and deliberately far above the 10 s every other collector gets.
 *
 * It is not one command, it is an interpreter cold-start plus nine CIM queries plus a registry walk
 * over what can be 400 uninstall keys, and on a busy or cold-cached server that legitimately takes
 * tens of seconds. Ten seconds here would not bound a pathological host — it would turn an ordinary
 * one into a host that reports NOTHING, which is the failure this budget exists to prevent, inverted.
 * The Scheduled Task's own `ExecutionTimeLimit` (5 minutes, set by install.ps1) is the outer layer,
 * the same role systemd's `RuntimeMaxSec=120` plays on Linux.
 */
export const WINDOWS_COLLECT_TIMEOUT_MS = 60_000;

// ── The document the script emits ─────────────────────────────────────────────────────────────────

/** One entry of either Uninstall hive, as `Get-ItemProperty` hands it over. */
export interface WindowsUninstallEntry {
  DisplayName?: string | null;
  DisplayVersion?: string | null;
  /** A DWORD; `1` marks an update stub or runtime fragment nobody wants in an inventory. */
  SystemComponent?: number | null;
}

/** The single JSON document the collection script produces. Every key may be absent or null. */
export interface WindowsFacts {
  os?: {
    Caption?: string | null;
    Version?: string | null;
    BuildNumber?: string | null;
    /** Round-trip ('o') formatted UTC, produced by the script — never a raw CIM DateTime. */
    LastBootUpTime?: string | null;
  } | null;
  cs?: {
    TotalPhysicalMemory?: number | string | null;
    Manufacturer?: string | null;
    Model?: string | null;
    Domain?: string | null;
    PartOfDomain?: boolean | null;
    DNSHostName?: string | null;
  } | null;
  cpu?: unknown;
  bios?: { SerialNumber?: string | null } | null;
  csp?: { UUID?: string | null } | null;
  enclosure?: { ChassisTypes?: number[] | number | null } | null;
  disks?: unknown;
  physicalDisks?: unknown;
  adapters?: unknown;
  adapterConfigs?: unknown;
  software?: unknown;
  machineGuid?: string | null;
  elevated?: boolean | null;
  /**
   * What `$ErrorActionPreference='SilentlyContinue'` swallowed, as `"<cmdlet>: <message>"` lines.
   * `unknown` for the same reason every other key is loosely typed: this document is parsed from a
   * host, not constructed here, so the mapper reads it defensively.
   */
  errors?: unknown;
}

interface WindowsCpu {
  Name?: string | null;
  NumberOfCores?: number | null;
  NumberOfLogicalProcessors?: number | null;
}
interface WindowsDiskDrive {
  DeviceID?: string | null;
  Model?: string | null;
  Size?: number | string | null;
}
interface WindowsPhysicalDisk {
  FriendlyName?: string | null;
  Size?: number | string | null;
}
interface WindowsAdapter {
  Index?: number | null;
  NetConnectionID?: string | null;
  MACAddress?: string | null;
  PhysicalAdapter?: boolean | null;
}
interface WindowsAdapterConfig {
  Index?: number | null;
  MACAddress?: string | null;
  IPAddress?: string[] | string | null;
  IPSubnet?: string[] | string | null;
}

/**
 * The script's stdout as a document, or `null` for anything that is not one.
 *
 * `null` is the honest answer for a PowerShell that could not run, a host where the interpreter
 * printed an error instead of JSON, and a body that parses to an array or a scalar — the script emits
 * exactly one object by construction, so anything else is a failure wearing valid JSON. Every one of
 * those lands on the same place: the report still goes out, carrying the facts the agent knows
 * without WMI (its hostname, its OS family) and a warning saying why the rest is missing.
 */
export function parseWindowsBlob(raw: string | null): WindowsFacts | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as WindowsFacts;
}

/**
 * How this module spawns. Injectable so the tests can drive the two impure boundaries — the PowerShell
 * calls and `docker ps` — without a Windows host; the production default is always {@link run}.
 */
export type Exec = typeof run;

/** The memoized dedup-key read. See {@link readMachineGuid}. */
let machineGuidRun: Promise<string | null> | undefined;

/**
 * `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` — the primary `externalId` on Windows.
 *
 * MEMOIZED, for the same reason {@link runFactsScript} is: `index.ts` asks for the dedup key TWICE on
 * a reporting tick (once for the cadence jitter key before the due gate, once inside `buildReport`)
 * and once on a tick that reports nothing at all. Without the memo that was an extra `powershell.exe`
 * start every five minutes on every Windows host in the estate, including the ~11 ticks out of 12
 * that do nothing. The memo holds the PROMISE, so a concurrent second caller joins the first call.
 *
 * Process-scoped is right here and would be wrong in a daemon: the agent is a one-shot (ADR-0074 §7),
 * so "once per process" IS "once per report" and the value cannot go stale within one.
 *
 * This is deliberately NOT folded into {@link WINDOWS_FACTS_SCRIPT}, even though that document
 * already carries `machineGuid`: the key is read BEFORE the cadence gate, so a tick that is not due
 * would then pay for the full CIM sweep it exists to avoid. A tiny registry read is the right cost
 * for the one fact every tick needs.
 */
export async function readMachineGuid(warn: Warn = NO_WARN, exec: Exec = run): Promise<string | null> {
  // Read through the same one-line PowerShell shape as everything else rather than a second
  // mechanism, so a host where PowerShell is blocked fails ONE way with ONE message.
  machineGuidRun ??= exec(
    [
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
    ],
    WINDOWS_COLLECT_TIMEOUT_MS,
    warn,
  );
  const value = (await machineGuidRun)?.trim();
  return value ? value : null;
}

// ── Virtualization and chassis ────────────────────────────────────────────────────────────────────

/**
 * Hypervisor signatures, matched against `Win32_ComputerSystem`'s manufacturer and model.
 *
 * Every entry is a string a guest's SYNTHETIC SMBIOS advertises and a physical board does not. The
 * pairs are ordered most-specific first because `Microsoft Corporation` alone is ambiguous — Surface
 * hardware ships exactly that manufacturer — so Hyper-V is recognised by the MODEL (`Virtual
 * Machine`), never by the vendor.
 */
const WINDOWS_VIRT_SIGNATURES: readonly [RegExp, AgentVirtualizationType][] = [
  [/vmware/i, "vmware"],
  [/virtual machine|hyper-?v/i, "hyperv"],
  [/qemu|\bkvm\b/i, "kvm"],
  [/\bxen\b/i, "xen"],
  // The contract's vocabulary has no VirtualBox/Parallels/EC2 member, and `other` is exactly what it
  // means: virtualized, kind not enumerated. Better than dropping a true and useful fact.
  [/virtualbox|innotek|parallels|bochs|bhyve|amazon ec2|google compute engine|alibaba cloud|openstack|nutanix|red hat/i, "other"],
];

/**
 * What this host runs UNDER, from its SMBIOS strings — or `undefined` when nothing says.
 *
 * `undefined`, never `none`. `none` is a POSITIVE bare-metal finding, and this collector has no probe
 * that can produce one: there is no `systemd-detect-virt` here, only the absence of a signature in a
 * vendor string, which is weaker evidence than it looks (a rebranded OEM image, a hypervisor that
 * passes the host's SMBIOS through). Saying nothing is the honest answer, and `host.chassis` still
 * classifies the machine — see {@link windowsChassis}, which is why the omission costs nothing.
 */
export function windowsVirtualization(
  manufacturer: string | null | undefined,
  model: string | null | undefined,
): AgentVirtualizationType | undefined {
  const haystack = `${manufacturer ?? ""} ${model ?? ""}`.trim();
  if (!haystack) return undefined;
  for (const [pattern, type] of WINDOWS_VIRT_SIGNATURES) {
    if (pattern.test(haystack)) return type;
  }
  return undefined;
}

/**
 * What the host IS, on Windows: a detected hypervisor wins, otherwise the SMBIOS enclosure code.
 *
 * This is deliberately NOT `chassisFor` from the Linux collector, and the difference is one rule.
 * There, an ABSENT virtualization probe forces `unknown`, because a Linux container reading
 * `/sys/class/dmi` gets the HOST's board and would confidently report `server`. A Windows agent
 * installed by `install.ps1` runs on the machine whose enclosure it is reading — there is no
 * equivalent exposure — so falling through to the enclosure code is correct here, and it is what
 * keeps every physical Windows host's laptop/desktop/server classification. On an estate of 180
 * endpoints that distinction is most of the value #1139 gets from this field.
 *
 * `Win32_SystemEnclosure.ChassisTypes` is an ARRAY (a chassis can declare several); the first entry
 * is the one Windows itself reports as the machine's form factor.
 */
export function windowsChassis(
  virtualization: AgentVirtualizationType | undefined,
  chassisTypes: number[] | number | null | undefined,
): AgentChassis {
  if (virtualization !== undefined && virtualization !== "none") {
    return virtualization === "docker" || virtualization === "lxc" || virtualization === "wsl"
      ? "container"
      : "vm";
  }
  // BOTH shapes: `ChassisTypes` is a collection, and a single-element collection may reach us as a
  // bare number (see `asArray`). Nearly every machine declares exactly one, so the collapsed shape is
  // the common case rather than the exotic one.
  const code =
    typeof chassisTypes === "number" ? chassisTypes : Number(asArray<number>(chassisTypes)[0]);
  if (!Number.isInteger(code)) return "unknown";
  return SMBIOS_CHASSIS[code] ?? "unknown";
}

// ── Software (the Uninstall hives) ────────────────────────────────────────────────────────────────

/**
 * The installed-software list, from BOTH Uninstall hives (#1144). `source` is `registry`, which is
 * the contract's own vocabulary for it.
 *
 * Two filters, and both are the difference between an inventory an operator reads and a wall of
 * noise: an entry with no `DisplayName` is a fragment with nothing to display, and `SystemComponent=1`
 * is Microsoft's own flag for "do not show this in Programs and Features" — update stubs, runtime
 * shards, driver payloads. They are applied HERE and ONLY here: {@link WINDOWS_FACTS_SCRIPT} selects
 * the three properties and filters nothing, deliberately, so the rule lives in the one place this
 * repo can actually test it rather than being split across a PowerShell string nothing here can run.
 *
 * WHAT IS NOT COLLECTED, and it is not a small gap: only the two MACHINE-WIDE (`HKLM`) Uninstall
 * hives are read. A per-USER install — anything registered under `HKCU`, which is where a great deal
 * of what a laptop user installs for themselves ends up — is NOT in this list, and reading it would
 * mean walking `HKU\<sid>` for every loaded profile from a SYSTEM context. That is its own piece of
 * work behind its own policy flag; until then the Manual says machine-wide rather than claiming
 * parity with what Windows shows in Apps & features.
 *
 * The two hives list the same product twice on any machine with both a 64- and a 32-bit installer
 * registered, so identical name+version pairs are collapsed. Two DIFFERENT versions of the same name
 * are kept: that is a real and interesting state (a half-finished upgrade), not a duplicate.
 */
export function parseWindowsSoftware(raw: unknown): Software {
  const seen = new Set<string>();
  const pkgs: Software = [];
  for (const entry of asArray<WindowsUninstallEntry>(raw)) {
    const name = entry?.DisplayName?.trim();
    if (!name) continue;
    if (Number(entry.SystemComponent) === 1) continue;
    const version = entry.DisplayVersion?.trim();
    const key = `${name}\0${version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pkgs.push({ name: name.slice(0, 255), ...(version ? { version: version.slice(0, 120) } : {}), source: "registry" });
  }
  return pkgs;
}

/**
 * The installed-software OUTCOME (#1142). Same three-state contract as Linux and for the same reason:
 * `disabled` clears the server's stored list, `unavailable` preserves it, and only this function has
 * the information to tell them apart.
 *
 * `unavailable` is the answer whenever the PowerShell call itself failed — a blocked interpreter, an
 * ExecutionPolicy that refuses, the collect timeout. It is never read as "this host has no software",
 * because a Windows box with zero installed programs does not exist and treating the two the same is
 * how an inventory gets wiped by a transient failure.
 */
export async function collectSoftware(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
  facts?: WindowsFacts | null,
): Promise<SoftwareCollection> {
  if (!policy.collect.software) {
    warn("software: disabled by agent policy — installed package list omitted");
    return { state: "disabled" };
  }
  // `collectHost` already paid for the one PowerShell call and passes its document in; a standalone
  // caller (the dispatcher's `collectSoftware`) makes it itself rather than going without.
  const blob = facts !== undefined ? facts : parseWindowsBlob(await runFactsScript(warn));
  if (!blob) {
    warn(
      "software: the Windows fact collector did not answer — installed list omitted (the stored list is kept)",
    );
    return { state: "unavailable" };
  }
  const pkgs = parseWindowsSoftware(blob.software);
  return {
    state: "reported",
    software: applySoftwarePolicy(pkgs.slice(0, SOFTWARE_CAP), policy, warn),
  };
}

// ── Containers ────────────────────────────────────────────────────────────────────────────────────

/**
 * The path Docker Desktop and Mirantis Container Runtime expose the engine API on, for the record.
 *
 * It is a NAMED PIPE, not a unix socket, and this collector deliberately does NOT dial it. Bun
 * documents `fetch({ unix })` as "the local file path to a unix domain socket" and says nothing about
 * Windows; Bun's named-pipe support has a documented history of ENOENT failures across `net.Server`,
 * `node:http` and `Bun.connect` (oven-sh/bun #11820, #13042, #14329, #24682), and this repo cannot
 * reach a Windows host to settle it — CI is Linux and the developers are on macOS. Shipping an
 * unverified impure boundary is exactly what cost this campaign an entire feature once already
 * (`Bun.file().exists()` answers `false` for a unix socket, and nobody checked).
 *
 * So the constant is exported to be NAMED in the ADR and in a future test, not to be opened. See
 * {@link collectContainers} for what is used instead and why.
 */
export const DOCKER_NAMED_PIPE = "\\\\.\\pipe\\docker_engine";

/** An executable lookup on PATH: the name asked for, the absolute path found, or `null`. */
export type Which = (name: string) => string | null;

/**
 * The extensions to try when the host exports no `PATHEXT`. The first four of Windows' own default,
 * which are the ones an executable a program shells out to can plausibly carry.
 */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve the docker client to an ABSOLUTE PATH, applying PATHEXT explicitly (#1144).
 *
 * WHY THIS EXISTS AT ALL. Windows has no execute bit and no extensionless executables: a bare
 * `docker` on PATH is `docker.exe` (or a `docker.cmd` shim), resolved through `PATHEXT`. Whether
 * `Bun.which("docker")` performs that expansion on Windows is undocumented, and this repo cannot
 * reach a Windows host to check — the SAME limit that kept {@link DOCKER_NAMED_PIPE} unopened. The
 * difference is that this one failed SILENTLY BY DESIGN: a lookup that missed made a host running
 * Docker Desktop report no containers, for ever, with nothing in `diagnostics.warnings` to say why.
 * So the expansion happens HERE, where it is testable, instead of being assumed of the runtime.
 *
 * The bare name is tried LAST rather than not at all, so the same function still resolves on a POSIX
 * host — the tests run on macOS and Linux, and a lookup that only worked on Windows could not be
 * exercised anywhere this repo can reach.
 */
export function resolveDockerClient(
  client: string,
  which: Which,
  pathext: string | undefined,
): string | null {
  const names: string[] = [];
  // A name that already carries an extension is taken as written — appending a second one would look
  // for `docker.exe.com`.
  if (!/\.[a-z0-9]+$/i.test(client)) {
    for (const ext of (pathext || DEFAULT_PATHEXT).split(";")) {
      const trimmed = ext.trim();
      if (trimmed) names.push(client + trimmed.toLowerCase());
    }
  }
  names.push(client);
  for (const name of names) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** One line of `docker ps --format {{json .}}` — the CLI's own shape, not the engine API's. */
interface DockerCliContainer {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  /** A rendered string: `0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp`. */
  Ports?: string;
}

/** `0.0.0.0:8080->80/tcp` · `[::]:8080->80/tcp` · `443/tcp` — the three shapes the CLI renders. */
const CLI_PORT = /^(?:(\[[0-9a-fA-F:]*\]|[0-9.]+):(\d+)->)?(\d+)\/([a-z]+)$/;

/**
 * Parse the CLI's rendered port list back into the contract's structured ports.
 *
 * A chunk that does not match is DROPPED rather than guessed at: the port list is decoration on a
 * container that is fully usable without it, and a wrong host port on a topology map is worse than
 * an absent one.
 */
function parseCliPorts(rendered: string | undefined): NonNullable<Containers[number]["ports"]> {
  const ports: NonNullable<Containers[number]["ports"]> = [];
  for (const chunk of (rendered ?? "").split(",")) {
    const m = chunk.trim().match(CLI_PORT);
    if (!m) continue;
    const containerPort = Number(m[3]);
    if (!Number.isInteger(containerPort)) continue;
    const hostPort = m[2] ? Number(m[2]) : undefined;
    // `[::]` is how the CLI renders the IPv6 wildcard; the engine API reports the bare `::`, and the
    // two paths must produce the same value or the same container would look different per OS.
    const hostIp = m[1]?.replace(/^\[|\]$/g, "");
    ports.push({
      containerPort,
      ...(hostPort !== undefined ? { hostPort } : {}),
      ...(hostIp ? { hostIp } : {}),
      ...(m[4] && CONTAINER_PORT_PROTOCOLS.has(m[4]) ? { protocol: m[4] as AgentContainerPortProtocol } : {}),
    });
  }
  return ports;
}

/**
 * Parse `docker ps --format "{{json .}}"` into the SAME `containers` shape `parseDockerContainers`
 * produces from the engine API (#1144), so a container reported by a Windows host and one reported by
 * a Linux host are indistinguishable on the server.
 *
 * `null` in, `undefined` out — "we could not look". EMPTY output, in contrast, is an EMPTY LIST: the
 * probe ran and this host runs nothing, which the server acts on by retiring the child nodes it holds.
 * That distinction is the same one the Linux path is built on and it is load-bearing here too.
 *
 * One field is unavoidably absent next to the API path: the CLI does not render the image DIGEST, so
 * `imageDigest` is omitted. The image TAG is present and that is what an operator reads.
 */
export function parseDockerCliContainers(out: string | null): Containers | undefined {
  if (out === null) return undefined;
  const containers: Containers = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: DockerCliContainer;
    try {
      raw = JSON.parse(trimmed) as DockerCliContainer;
    } catch {
      // One unreadable line must not cost the other containers — degrade, never reject.
      continue;
    }
    // A container with several names (legacy links) renders them comma-separated; the first is the
    // one `docker ps` shows and the one the engine API would have reported.
    const name = raw?.Names?.split(",")[0]?.replace(/^\/+/, "").trim();
    if (!name) continue;
    const ports = parseCliPorts(raw.Ports);
    containers.push({
      name: name.slice(0, 200),
      ...(raw.ID?.trim() ? { id: raw.ID.trim().slice(0, 12) } : {}),
      ...(raw.Image?.trim() ? { image: raw.Image.trim() } : {}),
      ...(raw.State?.trim() ? { state: mapContainerState(raw.State) } : {}),
      ...(ports.length ? { ports } : {}),
    });
  }
  return containers;
}

/**
 * The containers this Windows host runs (#1144) — the same fact the Linux collector reports, over a
 * different transport, producing the same wire shape.
 *
 * WHY THE CLI AND NOT THE PIPE OR TCP. Three transports exist and two are refused:
 *
 *  - the named pipe `\\.\pipe\docker_engine` — see {@link DOCKER_NAMED_PIPE}. Bun's `fetch({ unix })`
 *    is documented for unix sockets only and its Windows named-pipe support has a real bug history;
 *    this repo has no Windows host to verify it on, and an unverified impure boundary is the exact
 *    class of assumption that has already cost this campaign a feature.
 *  - `tcp://localhost:2375` — REFUSED outright, not merely unused. It is off by default and turning
 *    it on exposes an unauthenticated, root-equivalent Docker API on the host. An inventory agent
 *    that asks an operator to open that has made the estate less safe than it found it.
 *  - `docker.exe` on PATH — what this uses. Docker Desktop and the Mirantis Container Runtime both
 *    install it into the machine-wide PATH, so a run as SYSTEM normally finds it; it is a read-only
 *    call; and on Windows Server, where the engine runs as a service under SYSTEM, it is the same
 *    identity the engine already trusts. A host where it is NOT on PATH degrades to "no container
 *    list", silently — the same outcome as a host with no Docker, which is the honest reading.
 *
 * THE LOOKUP ITSELF GETS THE SAME TREATMENT AS THE PIPE. See {@link resolveDockerClient}: the
 * extensions are tried explicitly rather than trusting `Bun.which` to apply PATHEXT on Windows, and
 * the resolved ABSOLUTE PATH is what gets spawned, which keeps `Bun.spawn`'s own PATH resolution out
 * of it too. Refusing one unverified Windows boundary and then leaning on another would have been
 * the same mistake wearing a different name — and this one failed SILENTLY.
 *
 * THE LINUX PROPERTY IS PRESERVED, and it is the one the operator asked about: the lookup happens on
 * EVERY tick and nothing is cached, so a host registered with no Docker that gets Docker installed a
 * month later reports its containers on the very next tick — no re-install, no state to clear. A host
 * with no Docker client at all is SILENT, exactly like a Linux host with no socket: warning there
 * would put a line in the majority of the estate's reports until operators learned to ignore it.
 *
 * EVERYTHING AFTER A SUCCESSFUL LOOKUP WARNS. A client that resolved but cannot answer — the engine
 * is stopped, Desktop is not running because nobody is logged in, the pipe ACL refuses SYSTEM, the
 * call timed out — is the "why is this host's container list empty?" question `diagnostics.warnings`
 * exists to answer, and `run`'s own degradation notes are passed straight through rather than
 * swallowed into a local flag.
 */
export async function collectContainers(
  warn: Warn,
  client = "docker",
  which: Which = (name) => Bun.which(name),
  pathext: string | undefined = process.env.PATHEXT,
  exec: Exec = run,
): Promise<Host["containers"]> {
  const resolved = resolveDockerClient(client, which, pathext);
  if (!resolved) return undefined;
  const out = await exec([resolved, "ps", "--format", "{{json .}}"], WINDOWS_COLLECT_TIMEOUT_MS, warn);
  if (out === null) {
    warn(
      `containers: ${resolved} is installed but did not answer — container list omitted (is the engine running?)`,
    );
    return undefined;
  }
  return parseDockerCliContainers(out);
}

// ── Assembling the host block ─────────────────────────────────────────────────────────────────────

/**
 * The one collection script, run AT MOST ONCE per process.
 *
 * `buildReport` fires `collectHost` and `collectSoftware` concurrently, and on Windows both need this
 * document — so without the memo a single report would start two PowerShell interpreters and sweep
 * CIM twice, on the machines least able to spare it. The memo is the PROMISE, not the result, so the
 * concurrent second caller joins the first call rather than racing it.
 *
 * Process-scoped is exactly right here and would be wrong in a daemon: the agent is a one-shot
 * (ADR-0074 §7) — it runs, gathers, POSTs and exits — so "once per process" IS "once per report", and
 * the facts can never go stale within one. A long-lived agent would have to invalidate this.
 */
let factsScriptRun: Promise<string | null> | undefined;

async function runFactsScript(warn: Warn): Promise<string | null> {
  factsScriptRun ??= run(
    [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_FACTS_SCRIPT],
    WINDOWS_COLLECT_TIMEOUT_MS,
    warn,
  );
  return factsScriptRun;
}

/**
 * Clear both process-scoped memos — the fact document and the dedup key.
 *
 * FOR TESTS ONLY. The agent is a one-shot, so nothing in production ever wants a second collection
 * inside one process; a `bun test` process, in contrast, runs many scenarios back to back and would
 * otherwise see the first one's memoized answer in all of them.
 */
export function resetWindowsCollectorMemos(): void {
  factsScriptRun = undefined;
  machineGuidRun = undefined;
}

/** `fe80::…` → link, `::1` → host, `fc00::/7` → site, everything else → global. */
function ipv6Scope(address: string): AgentIpv6Scope {
  const a = address.toLowerCase();
  if (a === "::1") return "host";
  if (a.startsWith("fe80")) return "link";
  // Unique Local Addresses. `site` is the contract's nearest member: routable inside the
  // organisation, never on the public internet — which is the distinction the promotion mapper cares
  // about when it decides what to show as the node's address.
  if (/^f[cd]/.test(a)) return "site";
  return "global";
}

/**
 * Split one adapter's `IPAddress[]` into the contract's v4 and v6 shapes, using the parallel
 * `IPSubnet[]` for the prefix length.
 *
 * Windows reports a v4 entry's subnet as a MASK (`255.255.255.0`) and a v6 entry's as a plain prefix
 * length (`64`), which is what makes the discrimination reliable without parsing addresses twice.
 * `temporary` and `deprecated` have no source in this class and are OMITTED rather than defaulted —
 * absent means unknown, `false` would be a claim.
 */
function splitAddresses(cfg: WindowsAdapterConfig): { ipv4: string[]; ipv6: AgentNicIpv6[] } {
  const addresses = asArray<string>(cfg.IPAddress ?? []);
  const subnets = asArray<string>(cfg.IPSubnet ?? []);
  const ipv4: string[] = [];
  const ipv6: AgentNicIpv6[] = [];
  addresses.forEach((raw, i) => {
    const address = typeof raw === "string" ? raw.trim() : "";
    if (!address) return;
    if (!address.includes(":")) {
      ipv4.push(address);
      return;
    }
    const prefix = Number(subnets[i]);
    ipv6.push({
      address,
      ...(Number.isInteger(prefix) && prefix >= 0 && prefix <= 128 ? { prefixLength: prefix } : {}),
      scope: ipv6Scope(address),
    });
  });
  return { ipv4: ipv4.slice(0, 64), ipv6: ipv6.slice(0, 64) };
}

/**
 * NICs, joining `Win32_NetworkAdapter` (the operator-visible connection NAME and the physical flag)
 * to `Win32_NetworkAdapterConfiguration` (the addresses) on the adapter Index.
 *
 * The NAME is `NetConnectionID` — `Ethernet`, `Wi-Fi`, `vEthernet (WSL)` — because that is what an
 * operator sees in Windows and what a `LAZYIT_EXCLUDE_NICS` glob has to be able to match. The
 * adapter's `Description` (its hardware model) would be unrecognisable in both roles.
 *
 * `isVirtual` is `!PhysicalAdapter`, which is Windows' own answer and needs no inference — unlike
 * Linux, where it has to be derived from whether `/sys/class/net/<n>/device` exists.
 */
function buildNics(facts: WindowsFacts): Nics | undefined {
  const adapters = asArray<WindowsAdapter>(facts.adapters);
  if (adapters.length === 0) return undefined;
  const configs = new Map<number, WindowsAdapterConfig>();
  for (const cfg of asArray<WindowsAdapterConfig>(facts.adapterConfigs)) {
    if (typeof cfg?.Index === "number") configs.set(cfg.Index, cfg);
  }
  const nics: Nics = [];
  for (const adapter of adapters) {
    const name = adapter?.NetConnectionID?.trim();
    if (!name) continue;
    const cfg = typeof adapter.Index === "number" ? configs.get(adapter.Index) : undefined;
    const { ipv4, ipv6 } = cfg ? splitAddresses(cfg) : { ipv4: [], ipv6: [] };
    const nic: Nics[number] = { name };
    if (adapter.MACAddress?.trim()) nic.mac = adapter.MACAddress.trim();
    if (typeof adapter.PhysicalAdapter === "boolean") nic.isVirtual = !adapter.PhysicalAdapter;
    if (ipv4.length) nic.ipv4 = ipv4;
    if (ipv6.length) nic.ipv6 = ipv6;
    nics.push(nic);
  }
  return nics.length ? nics.slice(0, 64) : undefined;
}

/**
 * Physical disks. `Win32_DiskDrive` first — it is the class that names a device the way Windows does
 * (`\\.\PHYSICALDRIVE0`, the analogue of `/dev/sda`) — and `MSFT_PhysicalDisk` as the FALLBACK for
 * hosts where the first enumerates nothing (Storage Spaces, some paravirtual controllers). Reporting
 * nothing there would be indistinguishable from a host with no disks.
 *
 * NO `mountpoint`, on either path, and that is correct rather than missing: a Windows physical drive
 * is not mounted at a path — its volumes are, and a volume is not the disk. `applyDiskPolicy`'s rule
 * that a disk without a mountpoint is never matched by a mountpoint glob is what keeps that from
 * quietly emptying the list.
 */
function buildDisks(facts: WindowsFacts): Disks | undefined {
  /** One entry, or nothing when the source could not even name the device. */
  const toDisk = (device: string | undefined, size: unknown): Disks[number] | undefined => {
    const name = device?.trim();
    if (!name) return undefined;
    const sizeBytes = size != null ? Number(size) : Number.NaN;
    return {
      device: name.slice(0, 200),
      ...(Number.isFinite(sizeBytes) && sizeBytes > 0 ? { sizeBytes } : {}),
    };
  };
  const drives = asArray<WindowsDiskDrive>(facts.disks)
    .map((d) => toDisk(d?.DeviceID ?? d?.Model ?? undefined, d?.Size))
    .filter((d): d is Disks[number] => d !== undefined);
  if (drives.length) return drives.slice(0, 256);
  const physical = asArray<WindowsPhysicalDisk>(facts.physicalDisks)
    .map((d) => toDisk(d?.FriendlyName ?? undefined, d?.Size))
    .filter((d): d is Disks[number] => d !== undefined);
  return physical.length ? physical.slice(0, 256) : undefined;
}

/**
 * Assemble the `host` block from the collection document (#1144) — pure, so every mapping above is
 * testable without a Windows machine.
 *
 * `os.family` is stamped `windows` UNCONDITIONALLY, including when `facts` is null. This binary IS
 * the Windows build, so the answer is known even when WMI answered nothing at all — and omitting the
 * `os` block would let the contract's pre-v2 default land the host on `linux`, which is a confidently
 * WRONG platform on the fleet view rather than a missing one.
 *
 * `privileged` is what the collection OBSERVED, not what it hoped for: a document that never arrived
 * reports `false`, because an unprivileged run and a failed run both mean "do not expect the
 * root-only facts", and claiming elevation the agent never confirmed would make
 * `diagnostics.privileged` useless for the one question it answers.
 *
 * IT ALSO EXPLAINS WHAT IT COULD NOT MAP (#1138). See {@link warnEmptyWindowsFacts}: a fact group the
 * document came back empty for files its own note, so a blank column on a Windows row is answerable
 * exactly as it is on Linux.
 */
export function buildWindowsHost(
  facts: WindowsFacts | null,
  containers: Containers | undefined,
  policy: AgentPolicy,
  warn: Warn,
): HostFacts {
  const cs = facts?.cs ?? undefined;
  const dnsHostName = cs?.DNSHostName?.trim();
  const host: Host = { hostname: dnsHostName || osHostname() || "unknown" };

  host.os = {
    family: "windows",
    ...clean({
      name: facts?.os?.Caption?.trim(),
      version: facts?.os?.Version?.trim(),
      // The number an operator actually names a Windows release by (26100 = 24H2). Without it,
      // `version: "10.0.26100"` is the only clue and `Windows 11` reports a major version of 10.
      build: facts?.os?.BuildNumber?.trim(),
    }),
  };

  // Directory membership. The NAME is only reported when the host is actually joined, because
  // `Win32_ComputerSystem.Domain` holds the WORKGROUP name on a standalone machine and shipping that
  // as an AD domain would be a confidently wrong answer. `joined: false` is still reported — "not in
  // the directory" is the fact an operator triages on, and it is different from "we never looked".
  const joined = cs?.PartOfDomain;
  const domainName = cs?.Domain?.trim();
  if (typeof joined === "boolean") {
    host.domain = { ...(joined && domainName ? { name: domainName } : {}), joined };
    if (joined && domainName && dnsHostName) {
      host.fqdn = `${dnsHostName}.${domainName}`.toLowerCase().slice(0, 255);
    }
  }

  const cpus = asArray<WindowsCpu>(facts?.cpu);
  // PHYSICAL cores, summed across sockets — the same fact `/proc/cpuinfo`'s processor count does NOT
  // report on Linux (that one counts logical CPUs). The two collectors therefore disagree about SMT,
  // which is stated here rather than discovered: `cores` on Windows excludes hyper-threads.
  const cores = cpus.reduce((n, c) => n + (Number(c?.NumberOfCores) || 0), 0);
  const cpu = clean({ model: cpus[0]?.Name?.trim(), cores: cores || undefined });
  if (cpu) host.cpu = cpu;

  const memoryBytes = cs?.TotalPhysicalMemory != null ? Number(cs.TotalPhysicalMemory) : undefined;
  if (memoryBytes !== undefined && Number.isFinite(memoryBytes) && memoryBytes > 0) {
    host.memoryBytes = memoryBytes;
  }

  const bootedAt = facts?.os?.LastBootUpTime?.trim();
  if (bootedAt) {
    const parsed = new Date(bootedAt);
    if (!Number.isNaN(parsed.getTime())) host.bootedAt = parsed.toISOString();
  }

  const hardware = policy.collect.hardware
    ? clean({
        manufacturer: cs?.Manufacturer?.trim(),
        model: cs?.Model?.trim(),
        // The serial needs Administrator, exactly as dmidecode needs root on Linux; an unprivileged
        // run simply gets nothing here and `diagnostics.privileged` explains the empty column.
        serial: facts?.bios?.SerialNumber?.trim(),
      })
    : undefined;
  if (!policy.collect.hardware) {
    warn("hardware: disabled by agent policy — manufacturer/model/serial omitted");
  }
  if (hardware) host.hardware = hardware;

  const nics = applyNicPolicy(facts ? buildNics(facts) : undefined, policy, warn);
  const disks = applyDiskPolicy(facts ? buildDisks(facts) : undefined, policy, warn);
  if (nics) host.nics = nics;
  if (disks) host.disks = disks;

  const virtualization = windowsVirtualization(cs?.Manufacturer, cs?.Model);
  host.chassis = windowsChassis(virtualization, facts?.enclosure?.ChassisTypes);
  if (virtualization) host.virtualization = { type: virtualization };

  const identifiers = buildIdentifiers({
    windowsMachineGuid: facts?.machineGuid,
    smbiosUuid: facts?.csp?.UUID,
    serial: hardware?.serial,
    // WHICH mac is the contract's rule, not this collector's (#1138): it must be a property of the
    // NIC SET, because adapter enumeration order is not stable and #1141 compares this across reports.
    mac: selectPrimaryMac(nics),
  });
  if (identifiers) host.identifiers = identifiers;

  // ABSENT (the probe could not run) and `[]` (it ran and found none) are different answers the
  // server acts on differently, so an empty list is REPORTED rather than omitted (#1139).
  if (containers !== undefined) host.containers = containers;

  warnEmptyWindowsFacts(facts, host, policy, warn);

  return { host, privileged: facts?.elevated === true };
}

/**
 * Explain every column this document could not fill (#1138) — the Windows half of the rule every
 * Linux collector already follows.
 *
 * It reads the ASSEMBLED host rather than the raw document on purpose: "was this fact reported?" is
 * the question an operator is actually asking, and re-deriving it from the CIM keys would be a second
 * copy of the mapping above, free to drift from it. The class name is still named, because "empty" is
 * only half an answer — the other half is where to go and look.
 *
 * Three rules keep the notes worth reading:
 *
 *  - **No document ⇒ nothing here.** {@link collectHost} already files the one note that says the
 *    whole sweep failed; nine more would bury it.
 *  - **A policy veto is explained ONCE**, by the policy's own note. "Win32_BIOS returned nothing" is
 *    not even true when nothing was asked for.
 *  - **A healthy host is silent.** A warning on every report is noise, and noise is how the column
 *    stops being read.
 */
function warnEmptyWindowsFacts(
  facts: WindowsFacts | null,
  host: Host,
  policy: AgentPolicy,
  warn: Warn,
): void {
  if (!facts) return;

  // The script's OWN error text first — this is the "why" behind everything below, verbatim from the
  // host ("Access is denied.", "Invalid namespace"). Non-strings and blanks are dropped rather than
  // shipped as empty warnings: this array is parsed from a machine, not constructed here.
  for (const line of asArray<unknown>(facts.errors)) {
    const text = typeof line === "string" ? line.trim() : "";
    if (text) warn(`windows: ${text}`);
  }

  // `host.os` always carries `family`, so "nothing was learned" is exactly "family and nothing else".
  if (Object.keys(host.os ?? {}).length <= 1 && host.bootedAt === undefined) {
    warn(
      "os: Win32_OperatingSystem returned nothing — OS name, version, build and last-boot time omitted",
    );
  }
  if (!facts.cs) {
    warn(
      "system: Win32_ComputerSystem returned nothing — manufacturer, model, memory and domain membership omitted",
    );
  }
  if (!host.cpu) {
    warn("cpu: Win32_Processor enumerated nothing — CPU model and core count omitted");
  }
  // Only when the policy ASKED for it — otherwise the hardware veto above, or `applyNicPolicy` /
  // `applyDiskPolicy`, has already filed the one honest note.
  if (policy.collect.hardware && host.hardware?.serial === undefined) {
    warn(
      "hardware: Win32_BIOS reported no serial number — serial omitted (reading it needs Administrator)",
    );
  }
  if (policy.collect.nics && (host.nics === undefined || host.nics.length === 0)) {
    warn("nics: Win32_NetworkAdapter enumerated nothing — network interfaces omitted");
  }
  if (policy.collect.disks && (host.disks === undefined || host.disks.length === 0)) {
    warn(
      "disks: neither Win32_DiskDrive nor MSFT_PhysicalDisk enumerated anything — block devices omitted",
    );
  }
  // The identity evidence #1141 compares across reports. An absent MachineGuid is the sharpest of
  // these: it is the host's PRIMARY key on this platform.
  const kinds = new Set((host.identifiers ?? []).map((i) => i.kind));
  if (!kinds.has("windows-machine-guid")) {
    warn(
      "identity: HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid was unreadable — the primary Windows identifier is omitted",
    );
  }
  if (!kinds.has("smbios-uuid")) {
    warn(
      "identity: Win32_ComputerSystemProduct reported no usable UUID — the SMBIOS identifier is omitted",
    );
  }
}

/**
 * Gather the full `host` block on Windows, plus whether this run was privileged.
 *
 * ONE PowerShell call and one optional `docker ps`, fired concurrently. The policy decides what is
 * SPAWNED, not merely what is filtered — a host whose policy turns containers off must not pay for a
 * docker probe, exactly as the Linux collector never shells out to `dmidecode` when hardware is off.
 * The WMI classes cannot be turned off individually because they all ride the same call; the
 * corresponding facts are dropped in {@link buildWindowsHost} and each drop files its own warning, so
 * a disabled collector reads identically on both platforms.
 */
export async function collectHost(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
): Promise<HostFacts> {
  const [raw, containers] = await Promise.all([
    runFactsScript(warn),
    policy.collect.containers ? collectContainers(warn) : Promise.resolve(undefined),
  ]);
  if (!policy.collect.containers) {
    warn("containers: disabled by agent policy — container list omitted");
  }
  const facts = parseWindowsBlob(raw);
  if (!facts) {
    // The single most consequential degradation on this platform: with no document there is no
    // hardware, no NIC, no disk and no identity evidence, and every one of those columns would
    // otherwise be empty with nothing to say why.
    warn(
      "windows: the PowerShell fact collector returned nothing usable — OS, hardware, NICs, disks and identifiers omitted",
    );
  }
  return buildWindowsHost(facts, containers, policy, warn);
}
