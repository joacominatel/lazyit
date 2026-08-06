/**
 * Hyper-V guest inventory (ADR-0095, #1217) — the Windows half of the hypervisor collector.
 *
 * DETECTION DOES NOT LIVE HERE. It rides the existing facts sweep as one cheap `hyperv=$hv` key
 * (see `buildWindowsFactsScript` in `windows.ts`): `Get-Service vmms` exists AND the WMI namespace
 * `root\virtualization\v2` is reachable — the management stack, and NOTHING else. Never CPUID and
 * never the SMBIOS vendor strings, because the host's own root partition advertises "Microsoft Hv"
 * too (the classic false positive ADR-0095 §2 names). Folding detection into the sweep is what
 * gives a non-Hyper-V Windows host ZERO extra cost: this module's SECOND PowerShell document only
 * ever runs on a host whose sweep answered `hyperv: true` with the policy on.
 *
 * The second document keeps every invariant the facts script established (#1144/#1166/#1191):
 * single-quoted literals only, ASCII only, `$ErrorActionPreference='SilentlyContinue'` with the
 * swallowed `$Error` text shipped out LAST, the UTF-8 boundary declaration, one compressed JSON
 * document. And per #1188, every field parsed out of it is `unknown` and passes through a gate
 * function — this document is parsed FROM a host, never constructed here.
 *
 * This module deliberately imports nothing from `windows.ts` (which imports it) — the interpreter
 * constants are restated below with the same rationale rather than round-tripped through a cycle.
 */
import { AGENT_GUESTS_MAX, AGENT_POLICY_DEFAULT, type AgentPolicy } from "@lazyit/shared";
import {
  asArray,
  canonicalMac,
  NO_WARN,
  run,
  type Exec,
  type Guests,
  type Hypervisor,
  type HypervisorFacts,
  type Warn,
} from "./shared";

type Guest = Guests[number];
type GuestState = NonNullable<Guest["state"]>;

/** Windows PowerShell 5.1 — ships with every supported Windows; `pwsh` does not (see windows.ts). */
const POWERSHELL = "powershell.exe";

/** The sweep budget, matching `WINDOWS_COLLECT_TIMEOUT_MS`: an interpreter cold-start plus CIM. */
export const HYPERV_COLLECT_TIMEOUT_MS = 60_000;

/**
 * The guest sweep, as ONE line: `Get-VM` (identity, state, size), `Get-VMNetworkAdapter` (MACs,
 * joined on VMId), and `Msvm_VirtualSystemSettingData.BIOSGUID` — the SMBIOS UUID the guest sees,
 * which `Get-VM` itself does not expose and which is the whole §6 identity join. The CIM filter
 * keeps REALIZED systems only: without it every snapshot contributes its own settings row and the
 * BIOSGUID join would be one-to-many.
 *
 * Every projected value is forced through `[string]` in the script rather than trusted to
 * `ConvertTo-Json`: 5.1 renders an un-stringified enum (`State`) and Guid (`VMId`) in ways that
 * differ from 7.x, and the mapper should meet ONE spelling wherever possible — while still gating
 * every field as `unknown`, because a host, not this file, produced the document (#1188).
 *
 * `-ErrorAction Ignore` on the adapter query: a Hyper-V host with ZERO VMs answers `-VMName *`
 * with an error, and that non-finding must not put a warning line in every empty host's report.
 */
export const HYPERV_GUESTS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$ProgressPreference='SilentlyContinue'",
  // The UTF-8 boundary declaration (#1191) — before $Error.Clear(), so a refused setter cannot
  // leak into errors[].
  "try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false}catch{}",
  "$Error.Clear()",
  "$vms=@(Get-VM|ForEach-Object{[pscustomobject]@{Id=[string]$_.VMId;Name=[string]$_.Name;State=[string]$_.State;Cores=$_.ProcessorCount;MemoryBytes=$_.MemoryAssigned}})",
  "$nics=@(Get-VMNetworkAdapter -VMName * -ErrorAction Ignore|ForEach-Object{[pscustomobject]@{Id=[string]$_.VMId;Mac=[string]$_.MacAddress}})",
  "$bios=@(Get-CimInstance -Namespace 'root\\virtualization\\v2' -ClassName Msvm_VirtualSystemSettingData -Filter 'VirtualSystemType=''Microsoft:Hyper-V:System:Realized'''|ForEach-Object{[pscustomobject]@{Id=[string]$_.ConfigurationID;BiosGuid=[string]$_.BIOSGUID}})",
  // `errors` LAST — a hashtable literal evaluates in written order, which is the only reason it
  // sees what the earlier keys raised (the windows.ts rule, kept).
  "[pscustomobject]@{vms=$vms;nics=$nics;bios=$bios;errors=@($Error|Select-Object -First 10|ForEach-Object{('{0}: {1}' -f $_.CategoryInfo.Activity,$_.Exception.Message)})}|ConvertTo-Json -Compress -Depth 4",
].join(";");

/** One `$vms` element, as the host hands it over — every field untrusted (#1188). */
export interface HypervVmRow {
  Id?: unknown;
  Name?: unknown;
  State?: unknown;
  Cores?: unknown;
  MemoryBytes?: unknown;
}

/** One `$nics` element: the owning VM's GUID and one adapter's MAC (separator-less, Hyper-V style). */
export interface HypervNicRow {
  Id?: unknown;
  Mac?: unknown;
}

/** One `$bios` element: the VM's GUID (`ConfigurationID`) and its braced `BIOSGUID`. */
export interface HypervBiosRow {
  Id?: unknown;
  BiosGuid?: unknown;
}

/** The single JSON document {@link HYPERV_GUESTS_SCRIPT} emits. Every key may be absent or mangled. */
export interface HypervGuestsBlob {
  vms?: unknown;
  nics?: unknown;
  bios?: unknown;
  errors?: unknown;
}

/**
 * The sweep's stdout as a document, or `null` for anything that is not one — the same contract as
 * `parseWindowsBlob`: an interpreter error page, an array, a scalar, or nothing are all "we could
 * not look", which the caller must keep distinct from "this host runs no VMs".
 */
export function parseHypervBlob(raw: string | null): HypervGuestsBlob | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as HypervGuestsBlob;
}

/**
 * A host-parsed value as a canonical GUID — braces stripped, lower-cased, 8-4-4-4-12 validated —
 * or `undefined` for anything else. A GATE, not a coercion (#1188): the VMId is the guest's
 * permanent `ref` (ADR-0074 §3 — one thing = one node, forever), so junk here must cost the row,
 * never mint a child node keyed on garbage.
 */
export function hypervGuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bare = value.trim().replace(/^[{(]+/, "").replace(/[)}]+$/, "").toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)
    ? bare
    : undefined;
}

/**
 * `Get-VM` state → the contract's vocabulary. Names first; the bare enum INTEGERS ride along
 * because a 5.1 quirk (or a future edit dropping the `[string]` cast) would render the enum as its
 * number, and losing every state to `other` over a spelling would be the silent kind of skew.
 * `Saved` is the Hyper-V word for a suspended-to-disk guest.
 */
const HYPERV_STATES: Record<string, GuestState> = {
  running: "running",
  "2": "running",
  off: "stopped",
  "3": "stopped",
  saved: "suspended",
  "6": "suspended",
  paused: "paused",
  "9": "paused",
};

function mapHypervState(value: unknown): GuestState | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  return HYPERV_STATES[raw] ?? "other";
}

/** A positive finite number out of an untrusted field, or nothing. `0` means "not assigned", not a size. */
function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The document → the contract's `guests`. `null` in, `undefined` out — "could not look" must never
 * retire the server's children; a non-null document with zero VMs is an EMPTY list, the positive
 * finding that does. MACs arrive separator-less (`00155D0A2B01` — Hyper-V's own spelling) and leave
 * canonical (#1169); BIOSGUIDs arrive braced and leave as the contract's lower-case `smbiosUuid`.
 * A VM whose `Id` fails the GUID gate is dropped and the drop is explained — it is the identity
 * key, and a guessed one would be worse than an absent guest.
 */
export function buildHypervGuests(
  blob: HypervGuestsBlob | null,
  warn: Warn = NO_WARN,
): Guests | undefined {
  if (!blob) return undefined;

  // The sweep's own swallowed error text first — the "why" behind any empty column below.
  for (const line of asArray<unknown>(blob.errors)) {
    const text = typeof line === "string" ? line.trim() : "";
    if (text) warn(`hypervisor: ${text}`);
  }

  const macsByVm = new Map<string, string[]>();
  for (const row of asArray<HypervNicRow>(blob.nics)) {
    const id = hypervGuid(row?.Id);
    const mac = typeof row?.Mac === "string" ? canonicalMac(row.Mac) : undefined;
    if (!id || !mac) continue;
    const list = macsByVm.get(id) ?? [];
    if (!list.includes(mac)) list.push(mac);
    macsByVm.set(id, list);
  }

  const biosByVm = new Map<string, string>();
  for (const row of asArray<HypervBiosRow>(blob.bios)) {
    const id = hypervGuid(row?.Id);
    const uuid = hypervGuid(row?.BiosGuid);
    if (id && uuid) biosByVm.set(id, uuid);
  }

  const guests: Guests = [];
  let dropped = 0;
  for (const vm of asArray<HypervVmRow>(blob.vms)) {
    if (guests.length >= AGENT_GUESTS_MAX) break;
    const ref = hypervGuid(vm?.Id);
    if (!ref) {
      dropped += 1;
      continue;
    }
    const name = typeof vm.Name === "string" && vm.Name.trim() ? vm.Name.trim() : ref;
    const state = mapHypervState(vm.State);
    const cores = positiveNumber(vm.Cores);
    const memoryBytes = positiveNumber(vm.MemoryBytes);
    const macs = macsByVm.get(ref);
    const smbiosUuid = biosByVm.get(ref);
    guests.push({
      ref,
      name,
      kind: "hyperv",
      ...(state ? { state } : {}),
      ...(macs ? { macs } : {}),
      ...(smbiosUuid ? { smbiosUuid } : {}),
      ...(cores !== undefined && Number.isInteger(cores) ? { cores } : {}),
      ...(memoryBytes !== undefined ? { memoryBytes } : {}),
    });
  }
  if (dropped) {
    warn(
      `hypervisor: skipped ${dropped} Hyper-V ${dropped === 1 ? "VM" : "VMs"} with no usable VMId — the GUID is the guest's identity key`,
    );
  }
  return guests;
}

/**
 * The orchestrator `windows.ts`'s `collectHost` calls: gate on the policy, then on the detection
 * bit the facts sweep answered, then pay for the one extra interpreter start. The policy gate
 * lives HERE (like `collectSoftware`'s) so "turned off" files its one warning and skips the spawn
 * in one tested place; `detected` false is SILENT — "this box is not a hypervisor" is the common
 * case, not a degradation. `osVersion` (from the sweep's own `os.Version`) is the facet's version:
 * the Hyper-V role has no version of its own distinct from the OS build.
 */
export async function collectHypervisorWindows(
  warn: Warn = NO_WARN,
  policy: AgentPolicy = AGENT_POLICY_DEFAULT,
  detected = false,
  osVersion?: string,
  exec: Exec = run,
): Promise<HypervisorFacts | undefined> {
  if (!policy.collect.hypervisor) {
    warn("hypervisor: disabled by agent policy — hypervisor and guest inventory omitted");
    return undefined;
  }
  if (!detected) return undefined;

  const hypervisor: Hypervisor = {
    platform: "hyperv",
    ...(osVersion ? { version: osVersion } : {}),
  };
  const blob = parseHypervBlob(
    await exec(
      [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", HYPERV_GUESTS_SCRIPT],
      HYPERV_COLLECT_TIMEOUT_MS,
      warn,
    ),
  );
  if (!blob) {
    // ABSENT guests, not empty: detection fired, so children may exist server-side, and a sweep
    // that could not answer must not retire them.
    warn("hypervisor: Hyper-V detected but the guest sweep did not answer — guest list omitted");
    return { hypervisor };
  }
  return { hypervisor, guests: buildHypervGuests(blob, warn) };
}
