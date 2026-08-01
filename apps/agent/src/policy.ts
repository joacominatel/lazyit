/**
 * The agent's half of the server-driven policy channel (ADR-0074 §7 amendment, issue #1140).
 *
 * Two tiny files under `/var/lib/lazyit-agent`, and everything the interval inversion needs:
 *
 *  - **`policy.json`** — the last policy the server sent, written verbatim from a report ack and
 *    loaded at the START of the next run. The one-tick delay is the point: a policy is only ever
 *    applied by a run that started cleanly with it already on disk, so a bad policy can never brick a
 *    fleet mid-collection, and a rollback takes effect one tick after it is saved.
 *  - **`state.json`** — the last SUCCESSFUL report instant. This is what makes the schedule tick a
 *    fixed 5 minutes on every platform while the SERVER owns cadence: the scheduler wakes the agent
 *    often, and {@link agentPolicyDue} decides whether this tick is a report or a no-op. No unit file
 *    is ever rewritten, no `daemon-reload` is issued, and the same code path works identically under
 *    systemd, launchd and Windows Task Scheduler.
 *
 * BOTH FILES FAIL SAFE. A missing, truncated, corrupt or schema-invalid file reads as "nothing known",
 * which for the policy means the built-in defaults (exactly the pre-#1140 behaviour) and for the state
 * means "report now". An agent that could be wedged by its own cache would be worse than no cache.
 *
 * The policy cache is validated against the CLOSED {@link AgentPolicySchema} on the way in AND on the
 * way out. This file is read by a process running as root: half-understanding it and applying the rest
 * is precisely the behaviour a tampered cache would want.
 */
import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AGENT_POLICY_DEFAULT,
  AgentPolicyGlobSchema,
  AgentPolicySchema,
  type AgentLocalLimits,
  type AgentPolicy,
  type AgentPolicyCollect,
} from "@lazyit/shared";

/** State that survives a reboot, so a site-wide restart does not produce a site-wide report burst. */
export const POLICY_DIR = "/var/lib/lazyit-agent";
export const POLICY_FILE = `${POLICY_DIR}/policy.json`;
export const STATE_FILE = `${POLICY_DIR}/state.json`;

/**
 * What the agent remembers between runs. Deliberately tiny — this is a clock and a checksum, not a
 * database; nothing here is ever the source of a FACT, only of a decision the server can overrule.
 */
export interface AgentState {
  /** Epoch ms of the last report the server ACCEPTED. Absent on a first run or a deleted file. */
  lastSuccessMs?: number;
  /**
   * Fingerprint of the software list the last ACCEPTED report left the server holding (#1142) — what
   * lets the next run omit an unchanged list. Absent means "send everything", which is why every
   * degenerate read below (missing file, truncated JSON, a non-string value) lands there: the failure
   * mode of forgetting is one large report, and the failure mode of a wrong memory is an inventory
   * that is never corrected.
   */
  softwareHash?: string;
}

/** Write `text` to `file` atomically-ish (temp + rename) with owner-only permissions. */
async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await Bun.write(tmp, text);
  await chmod(tmp, 0o600);
  // Rename is atomic within a filesystem, so a run killed mid-write (systemd's `RuntimeMaxSec`, a
  // reboot) leaves the PREVIOUS good file in place rather than a half-written one the next run would
  // have to reject. Cheap, and it removes a whole class of "why did this host lose its policy".
  await rename(tmp, file);
}

/**
 * The policy this run should apply: the cached one when it is present and fully valid, otherwise the
 * built-in defaults.
 *
 * A missing cache is NOT a degraded state. It is a first run, a host whose file was deleted, or an
 * agent talking to a server that predates the policy channel — and in all three the built-in default
 * is byte-for-byte the behaviour the agent had before this feature existed. That equivalence is why
 * the pickup flow needs no bootstrap request and has no chicken-and-egg.
 */
export async function loadCachedPolicy(file = POLICY_FILE): Promise<AgentPolicy> {
  let raw: string;
  try {
    raw = await Bun.file(file).text();
  } catch {
    return AGENT_POLICY_DEFAULT;
  }
  try {
    const parsed = AgentPolicySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : AGENT_POLICY_DEFAULT;
  } catch {
    // Truncated JSON — a run killed mid-write by an older agent, or a full disk.
    return AGENT_POLICY_DEFAULT;
  }
}

/**
 * Persist a policy the server just sent. VALIDATED before it touches the disk, so an ack that somehow
 * carried something outside the closed set never becomes a file the next run will read.
 */
export async function writeCachedPolicy(
  policy: AgentPolicy,
  file = POLICY_FILE,
): Promise<void> {
  const parsed = AgentPolicySchema.safeParse(policy);
  if (!parsed.success) return;
  await writePrivate(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
}

/** The last-success clock, or `{}` for anything unreadable — which the due gate reads as "report now". */
export async function loadState(file = STATE_FILE): Promise<AgentState> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(file).text());
    const raw = (
      typeof parsed === "object" && parsed !== null ? parsed : {}
    ) as { lastSuccessMs?: unknown; softwareHash?: unknown };
    const lastSuccessMs =
      typeof raw.lastSuccessMs === "number" &&
      Number.isFinite(raw.lastSuccessMs) &&
      raw.lastSuccessMs > 0
        ? raw.lastSuccessMs
        : undefined;
    // Each field is validated on its own: a corrupt clock must not cost the fingerprint (a needless
    // full resend) and a corrupt fingerprint must not cost the clock (a needless report burst).
    const softwareHash =
      typeof raw.softwareHash === "string" && raw.softwareHash.length > 0
        ? raw.softwareHash
        : undefined;
    return {
      ...(lastSuccessMs !== undefined ? { lastSuccessMs } : {}),
      ...(softwareHash !== undefined ? { softwareHash } : {}),
    };
  } catch {
    return {};
  }
}

export async function writeState(state: AgentState, file = STATE_FILE): Promise<void> {
  await writePrivate(file, `${JSON.stringify(state)}\n`);
}

/** Parse a `KEY=VALUE` truthiness the way a shell operator expects. Only FALSE is meaningful here. */
function isFalse(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

/** A positive integer, or undefined for anything else — a malformed limit is ignored, never guessed. */
function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Split a comma-separated glob list, dropping blanks and anything that is not a valid glob. */
function globList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const globs = value
    .split(",")
    .map((g) => g.trim())
    .filter((g) => AgentPolicyGlobSchema.safeParse(g).success);
  return globs.length ? globs : undefined;
}

/** The config keys that map to a collector toggle, in the order they appear in the policy schema. */
const COLLECT_KEYS: readonly [keyof AgentPolicyCollect, string][] = [
  ["hardware", "LAZYIT_COLLECT_HARDWARE"],
  ["disks", "LAZYIT_COLLECT_DISKS"],
  ["nics", "LAZYIT_COLLECT_NICS"],
  ["software", "LAZYIT_COLLECT_SOFTWARE"],
  ["containers", "LAZYIT_COLLECT_CONTAINERS"],
];

/**
 * Read the host's own `/etc/lazyit-agent/config` as a set of LIMITS on any server policy — hard rule
 * 1 of #1140: **local may VETO, never WIDEN.**
 *
 * Only restrictive readings are carried. `LAZYIT_COLLECT_SOFTWARE=true` produces NOTHING, because a
 * local `true` re-enabling a collector the server turned off would be widening; `LAZYIT_MIN_INTERVAL`
 * is a floor, so it can only make reporting less frequent; `LAZYIT_SOFTWARE_MAX` is a ceiling; and the
 * exclusion lists are unioned with the server's, which only ever narrows. There is no shape here that
 * can loosen anything, which is what makes the rule a property of the code rather than a promise.
 *
 * `LAZYIT_INTERVAL` is deliberately NOT read as the floor. `install.sh` has written it on every host
 * since the agent shipped, so reading it as a veto would silently pin every upgraded install at 15
 * minutes and make the server's cadence unusable from day one. An operator who wants a floor sets the
 * new, explicit `LAZYIT_MIN_INTERVAL`.
 */
export function localLimitsFrom(file: Record<string, string>): AgentLocalLimits {
  const collect: Partial<AgentPolicyCollect> = {};
  for (const [field, key] of COLLECT_KEYS) {
    if (isFalse(file[key])) collect[field] = false;
  }
  const exclude = {
    ...(globList(file.LAZYIT_EXCLUDE_NICS)
      ? { nicNames: globList(file.LAZYIT_EXCLUDE_NICS) as string[] }
      : {}),
    ...(globList(file.LAZYIT_EXCLUDE_MOUNTPOINTS)
      ? { mountpoints: globList(file.LAZYIT_EXCLUDE_MOUNTPOINTS) as string[] }
      : {}),
    ...(globList(file.LAZYIT_EXCLUDE_SOFTWARE)
      ? { softwareNames: globList(file.LAZYIT_EXCLUDE_SOFTWARE) as string[] }
      : {}),
  };
  const minIntervalSeconds = positiveInt(file.LAZYIT_MIN_INTERVAL);
  const softwareMax = positiveInt(file.LAZYIT_SOFTWARE_MAX);
  return {
    ...(Object.keys(collect).length ? { collect } : {}),
    ...(minIntervalSeconds !== undefined ? { minIntervalSeconds } : {}),
    ...(softwareMax !== undefined ? { softwareMax } : {}),
    ...(Object.keys(exclude).length ? { exclude } : {}),
  };
}
