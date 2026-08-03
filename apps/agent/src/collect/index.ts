/**
 * The collector DISPATCHER (#1144) — one import site, two implementations, chosen by platform.
 *
 * Before Windows existed there was one file and "the collector" meant "the Linux collector". Adding
 * a second OS by growing that file with `process.platform` branches would have put two unrelated
 * failure models in every function; instead each OS owns a file (`./linux.ts`, `./windows.ts`),
 * everything genuinely OS-neutral lives in `./shared.ts`, and this module picks one and re-exports
 * the shared surface so nothing else in the agent has to know which host it is on.
 *
 * WHAT IS DISPATCHED, AND WHAT IS NOT. Three things differ per OS — the host facts, the installed
 * software, and the primary identity key — so those three are dispatched. Everything else re-exported
 * below is the SAME code on both platforms, which is why the mapper tests in `collect.test.ts` are
 * platform-independent and run unchanged on a macOS laptop and a Linux CI runner.
 *
 * The choice is `process.platform === "win32"` and nothing more elaborate: the compiled artifacts are
 * per-target (`bun-linux-*` vs `bun-windows-x64`), so this is never ambiguous at runtime.
 *
 * macOS is deliberately NOT a third branch, and what that means precisely: a Bun process on darwin
 * takes the LINUX path, where every collector degrades the file or tool it cannot find into an
 * omitted fact — but `readHostId` finds no `/etc/machine-id`, so the RUN then fails with "could not
 * read … (the dedup key)" before anything is sent. That is the correct outcome for a platform no
 * installer targets: it is a clear refusal, not a crash and not a half-report. It is emphatically not
 * a claim that macOS is supported; a darwin collector is its own piece of work.
 */
import type { AgentPolicy } from "@lazyit/shared";
import type { SoftwareCollection } from "../software-delta";
import * as linux from "./linux";
import * as windows from "./windows";
import { NO_WARN, type HostFacts, type Warn } from "./shared";

/** Is this process the Windows build? The one platform test the agent makes, in one place. */
export const IS_WINDOWS = process.platform === "win32";

/**
 * WHERE this host's primary identity comes from, spelled the way an operator would look it up.
 *
 * It is a message string, not a path the agent opens — every consumer is an error message or a
 * diagnostic line. Naming the Windows source in full (rather than "the registry") is the difference
 * between an operator who can check it and one who has to ask.
 */
export const HOST_ID_SOURCE = IS_WINDOWS
  ? "HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid"
  : "/etc/machine-id";

/**
 * The host's PRIMARY dedup key — `externalId` (ADR-0074 §3: one host = one node, forever).
 *
 * Linux reads `/etc/machine-id`; Windows reads `MachineGuid` (#1144). The two are deliberately the
 * SAME KIND of fact — a value generated once when the OS was installed, surviving reboots, hardware
 * changes and renames — which is what lets one server-side key work for both. They differ in one
 * documented way, and the asymmetry is the reason `host.identifiers[]` exists beside this: MachineGuid
 * survives a motherboard transplant but not an OS reinstall, while the SMBIOS UUID is the reverse.
 *
 * `null` means the host has no usable key, which is fatal for reporting and is reported as such by
 * the caller — never silently substituted with a hostname, which is not stable and not unique.
 */
export async function readHostId(): Promise<string | null> {
  return IS_WINDOWS ? windows.readMachineGuid() : linux.readMachineId();
}

/**
 * Gather the `host` block and the privilege this run had. See {@link HostFacts} for why the two
 * travel together.
 */
export async function collectHost(
  warn: Warn = NO_WARN,
  policy?: AgentPolicy,
): Promise<HostFacts> {
  return IS_WINDOWS ? windows.collectHost(warn, policy) : linux.collectHost(warn, policy);
}

/** The installed-software OUTCOME (#1142) for this platform: reported / unchanged-eligible / unavailable / disabled. */
export async function collectSoftware(
  warn: Warn = NO_WARN,
  policy?: AgentPolicy,
): Promise<SoftwareCollection> {
  return IS_WINDOWS ? windows.collectSoftware(warn, policy) : linux.collectSoftware(warn, policy);
}

// ── The OS-neutral surface, re-exported so callers import from one place ──────────────────────────
export {
  applyDiskPolicy,
  applyNicPolicy,
  applySoftwarePolicy,
  asArray,
  buildDiagnostics,
  buildIdentifiers,
  clean,
  COLLECT_TIMEOUT_MS,
  mapContainerState,
  NO_WARN,
  parseDockerContainers,
  run,
  SMBIOS_CHASSIS,
  SOFTWARE_CAP,
  type Containers,
  type Disks,
  type Host,
  type HostFacts,
  type IdentifierFacts,
  type Identifiers,
  type Nics,
  type Software,
  type Warn,
} from "./shared";

// ── Linux internals, re-exported for the tests that pin their behaviour ───────────────────────────
export {
  chassisFor,
  collectContainers,
  collectOs,
  DOCKER_SOCKET,
  mapVirtualizationType,
  parseBootedAt,
  parseNics,
  parseTabbed,
  readMachineId,
} from "./linux";

// ── Windows internals, same reason ────────────────────────────────────────────────────────────────
//
// `collectContainers` is NOT re-exported from here: both collectors define one and they take
// different transports, so a single re-exported name would silently resolve to whichever import came
// last. The Linux one keeps the unqualified name it has always had (above); the Windows one is
// reached through `windows.collectContainers`, which is how `collectHost` calls it.
export {
  buildWindowsHost,
  DOCKER_NAMED_PIPE,
  parseDockerCliContainers,
  parseWindowsBlob,
  parseWindowsSoftware,
  readMachineGuid,
  windowsChassis,
  windowsVirtualization,
  WINDOWS_COLLECT_TIMEOUT_MS,
  WINDOWS_FACTS_SCRIPT,
  type WindowsFacts,
} from "./windows";
