/**
 * Server-driven agent policy (ADR-0074 §7 amendment, issue #1140) — the closed configuration surface
 * the server hands a reporting agent, and the pure logic that resolves, vetoes and schedules it.
 *
 * WHY IT EXISTS. Before this, the agent's whole configuration was three keys in a per-host file, and
 * the reporting cadence was not even one of them — the systemd timer owned it. Changing anything meant
 * SSHing to every host, i.e. a per-host config file that is a distributed spreadsheet, which is the
 * exact thing lazyit exists to abolish.
 *
 * TWO RULES THIS MODULE ENFORCES IN CODE, not in prose:
 *
 *  1. **The schema is a CLOSED set of booleans, integers and GLOBS.** No commands, no scripts, no
 *     paths to read, no server-supplied regex. `AgentPolicySchema` is `z.strictObject` at every depth
 *     — the deliberate INVERSE of `AgentReportSchema`, whose root is loose so a newer agent never
 *     vanishes from the CMDB. The directions are not symmetric: a report is data flowing INTO a
 *     server, while a policy is instruction flowing INTO a process running as root. A key this build
 *     does not understand must never be accepted there. Globs rather than regex for the same reason:
 *     a server-supplied regex is a ReDoS primitive against a root process, and {@link globMatches} is
 *     a two-pointer matcher that compiles nothing.
 *  2. **Local config may VETO, never WIDEN** ({@link applyAgentPolicyVeto}). A host whose own config
 *     file says "never collect software" cannot have that turned back on by any server policy. On a
 *     self-hosted product the host owner and the lazyit admin are frequently different people, and
 *     this is the honest posture for that.
 *
 * Pure and framework-agnostic (no I/O, no zod-outside-schemas): api resolves and serves it, the agent
 * caches and applies it, and web renders it — one definition, three consumers.
 */
import { z } from "zod";

// ── Bounds ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The FIXED schedule tick every platform installs, in seconds (#1140). It is not the cadence — it is
 * how often the agent WAKES UP to ask whether it is due, and the agent no-ops when it is not.
 *
 * This is the interval inversion. Making the server own cadence by rewriting a systemd unit and
 * `daemon-reload`-ing would be a root filesystem mutation driven by an HTTP response — an unpleasant
 * capability to grant a fleet agent — and it ports to neither launchd nor Windows Task Scheduler. A
 * fixed short tick plus a local no-op gate gives the server cadence from 5 minutes to 24 hours with
 * zero unit-file mutation and identical semantics on every scheduler.
 */
export const AGENT_POLICY_TICK_SECONDS = 300;

/** No cadence can be shorter than the tick — the agent physically cannot wake more often than this. */
export const AGENT_POLICY_INTERVAL_MIN_SECONDS = AGENT_POLICY_TICK_SECONDS;

/** 24 h. Past a day the node is stale on any sane threshold, so a longer cadence is a broken one. */
export const AGENT_POLICY_INTERVAL_MAX_SECONDS = 86_400;

/** Staleness floor: below one tick the sweeper would flip a healthy host OFFLINE between reports. */
export const AGENT_POLICY_STALE_MIN_SECONDS = AGENT_POLICY_TICK_SECONDS;

/** Staleness ceiling — 7 days. A host dark for a week is not "possibly fine", whatever the cadence. */
export const AGENT_POLICY_STALE_MAX_SECONDS = 604_800;

/** Matches `AgentReportSchema.software`'s own `.max(5000)`: a policy can lower the cap, never raise it. */
export const AGENT_POLICY_SOFTWARE_MAX = 5000;

/** Patterns per exclusion list. Enough for a real estate's plumbing, small enough to stay inert. */
export const AGENT_POLICY_GLOBS_MAX = 32;

/** One pattern's length. Long enough for a mountpoint, short enough that 32 of them stay tiny. */
export const AGENT_POLICY_GLOB_LENGTH_MAX = 200;

// ── Globs ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The characters a policy glob may contain: letters, digits, and the small punctuation set that
 * appears in NIC names, mountpoints and package names — plus `*` and `?`, the only two wildcards.
 *
 * An ALLOWLIST, not a metacharacter blocklist. Every regex metacharacter (`( ) [ ] { } + | ^ $ \ .`)
 * is absent from it, so a pattern that would be a regex cannot be stored in the first place, and the
 * check cannot be defeated by a form this file's author failed to anticipate. `/` and `.` deserve a
 * word each: `/` is in (a mountpoint is a path), `.` is OUT — a package name like `libssl1.1` would
 * want it, but admitting `.` is admitting the single most load-bearing regex metacharacter into a
 * string operators will inevitably paste regexes into. `?` covers the one-character case instead, and
 * `*` covers the rest.
 */
const AGENT_POLICY_GLOB_ALLOWED = /^[A-Za-z0-9_\-/:*?]+$/;

/**
 * One exclusion pattern. A GLOB — never a regex, and never compiled into one (see {@link globMatches}).
 * A server that can push a regex to a root process can hang it; a server that can push a glob can, at
 * absolute worst, make a host report fewer NICs than it has.
 */
export const AgentPolicyGlobSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_POLICY_GLOB_LENGTH_MAX)
  .regex(
    AGENT_POLICY_GLOB_ALLOWED,
    "Use a glob (letters, digits, - _ / : and the * and ? wildcards) — regular expressions are not accepted",
  );

/**
 * Does `value` match this glob? `*` matches any run of characters, `?` matches exactly one, and
 * everything else matches itself, case-insensitively (NIC and package names are compared, not parsed).
 *
 * A TWO-POINTER matcher, deliberately, rather than translating the glob into a `RegExp`. The naive
 * translation of `*a*a*a*b` is a catastrophic-backtracking pattern, and this runs inside a process
 * running as root against a pattern the SERVER chose — which is precisely the shape of a remote DoS.
 * The two-pointer walk backtracks only to the last `*`, so it is O(pattern × value) in the worst case
 * and linear in every realistic one, with no engine to trip.
 */
export function globMatches(glob: string, value: string): boolean {
  const pattern = glob.toLowerCase();
  const subject = value.toLowerCase();
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < subject.length) {
    const pc = pattern[p];
    if (p < pattern.length && (pc === "?" || pc === subject[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pc === "*") {
      starP = p;
      starS = s;
      p += 1;
    } else if (starP !== -1) {
      // Backtrack to the last `*` and let it swallow one more character.
      p = starP + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Does `value` match ANY of these globs? An EMPTY list matches nothing — no globs excludes nothing. */
export function matchesAnyGlob(globs: readonly string[], value: string): boolean {
  return globs.some((g) => globMatches(g, value));
}

// ── The policy itself ─────────────────────────────────────────────────────────────────────────────

/**
 * Which collectors run. Five booleans and nothing else — the closed set. A collector turned off here
 * simply omits its facts, which is the SAME degraded shape `AgentReportSchema` has accepted since v1
 * (a partial report is valid, never a 400), so turning one off needs no server-side special case.
 */
export const AgentPolicyCollectSchema = z.strictObject({
  /** `dmidecode` manufacturer/model/serial. Root-only anyway; off means the agent never even asks. */
  hardware: z.boolean(),
  disks: z.boolean(),
  nics: z.boolean(),
  /** The installed-package list — by far the largest part of a report, and the usual thing to cut. */
  software: z.boolean(),
  containers: z.boolean(),
});
export type AgentPolicyCollect = z.infer<typeof AgentPolicyCollectSchema>;

/**
 * Name patterns a host must NOT report. Globs, per {@link AgentPolicyGlobSchema}.
 *
 * These are FILTERS on facts the agent already collected, never instructions about what to read: a
 * `mountpoints` entry says "do not report this mountpoint", it does NOT say "read this path". The
 * distinction is the whole security posture — nothing here can widen what the agent touches.
 */
export const AgentPolicyExcludeSchema = z.strictObject({
  /** e.g. `veth*`, `docker*`, `br-*` — container plumbing that turns a NIC list into noise. */
  nicNames: z.array(AgentPolicyGlobSchema).max(AGENT_POLICY_GLOBS_MAX),
  /** e.g. `/var/lib/docker/*`, `/snap/*` — overlay mounts that are not disks anyone inventories. */
  mountpoints: z.array(AgentPolicyGlobSchema).max(AGENT_POLICY_GLOBS_MAX),
  /** e.g. `linux-image-*` — kernel churn that makes every diff of an inventory useless. */
  softwareNames: z.array(AgentPolicyGlobSchema).max(AGENT_POLICY_GLOBS_MAX),
});
export type AgentPolicyExclude = z.infer<typeof AgentPolicyExcludeSchema>;

/**
 * Which package managers' output a policy may filter on — the SAME value set as the report contract's
 * `AgentSoftwareSourceSchema`, restated here rather than imported.
 *
 * This module is deliberately a LEAF: `infra.ts` imports {@link AgentPolicySchema} to extend the
 * report ack, so an import back the other way would make the two files a cycle, and a cycle between
 * two modules that both build `z.enum` values at import time is a class of initialisation bug worth
 * paying two lines to never have. The duplication is guarded by a test that asserts the two option
 * lists are identical, so drift fails CI rather than shipping a policy that silently filters nothing.
 */
export const AgentPolicySoftwareSourceSchema = z.enum([
  "dpkg",
  "rpm",
  "apk",
  "registry",
  "msi",
  "appx",
  "winget",
  "brew",
  "app-bundle",
  "pkg",
]);

/**
 * The COMPLETE, resolved policy an agent applies — every field present, nothing to infer. This is the
 * shape that rides the report ack and the shape the agent writes to its local cache verbatim.
 *
 * `z.strictObject` at every depth, unlike `AgentReportSchema`. See this module's header for why the
 * two directions are deliberately asymmetric.
 */
export const AgentPolicySchema = z.strictObject({
  /**
   * The instance's policy generation. Monotonic, bumped by ANY policy write at ANY scope, and echoed
   * back by the agent in its next report as `policyRevision` — which is what turns "we configured the
   * fleet" into "we can see that the fleet applied it".
   */
  revision: z.number().int().nonnegative(),
  /** Reporting cadence. The agent no-ops on ticks inside it (see {@link agentPolicyDue}). */
  intervalSeconds: z
    .number()
    .int()
    .min(AGENT_POLICY_INTERVAL_MIN_SECONDS)
    .max(AGENT_POLICY_INTERVAL_MAX_SECONDS),
  /**
   * How long after its last report a node is considered stale. Carried in the policy — and therefore
   * per-node-resolvable — because the server's staleness cutoff was a single global env var, which
   * made heterogeneous cadences structurally impossible: a host reporting daily would sit OFFLINE 23
   * hours out of 24 and nudge the bell every day.
   */
  staleAfterSeconds: z
    .number()
    .int()
    .min(AGENT_POLICY_STALE_MIN_SECONDS)
    .max(AGENT_POLICY_STALE_MAX_SECONDS),
  collect: AgentPolicyCollectSchema,
  /**
   * Which package managers' output to keep. An EMPTY array means "keep every source", not "keep
   * none". An empty filter is not a filter, and reading it as one would make the natural "I have not
   * configured this" value silently blank a host's whole software list.
   */
  softwareSources: z.array(AgentPolicySoftwareSourceSchema).max(16),
  exclude: AgentPolicyExcludeSchema,
  /** Hard cap on reported packages, at or below the wire contract's own array max. */
  softwareMax: z.number().int().min(0).max(AGENT_POLICY_SOFTWARE_MAX),
});
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;

/**
 * What the agent does with NO policy at all — first run ever, a deleted cache, or an instance that
 * predates #1140. It is exactly the pre-#1140 behaviour: every collector on, nothing excluded, the
 * 15-minute cadence `install.sh` has always written, and the 5000-package contract cap.
 *
 * That equivalence is the whole reason the pickup flow needs no bootstrap: an agent with no cache is
 * not degraded, it is simply the agent that shipped before this feature existed.
 */
export const AGENT_POLICY_DEFAULT: AgentPolicy = {
  revision: 0,
  intervalSeconds: 900,
  // 45 minutes: three times the default cadence, so a host has to miss two reports before it is
  // called dark and one dropped report never trips a false OFFLINE. It is deliberately the same
  // value as `INFRA_AGENT_STALE_AFTER_MS_DEFAULT` — the "small multiple of the report interval"
  // ADR-0074 §4 has always specified, now expressed as a policy field rather than a global env var.
  staleAfterSeconds: 2700,
  collect: {
    hardware: true,
    disks: true,
    nics: true,
    software: true,
    containers: true,
  },
  softwareSources: [],
  exclude: { nicNames: [], mountpoints: [], softwareNames: [] },
  softwareMax: AGENT_POLICY_SOFTWARE_MAX,
};

/**
 * What ONE stored scope may say — every field optional, so a layer states only what it changes.
 *
 * `revision` is absent on purpose: the counter is the server's, derived from the write, never
 * something a stored row or an API caller can set. Strict at every depth, exactly like the resolved
 * shape, so the closed-set rule holds on the WRITE path too and not merely on the wire.
 */
export const AgentPolicyOverrideSchema = z.strictObject({
  intervalSeconds: AgentPolicySchema.shape.intervalSeconds.optional(),
  staleAfterSeconds: AgentPolicySchema.shape.staleAfterSeconds.optional(),
  collect: AgentPolicyCollectSchema.partial().optional(),
  softwareSources: AgentPolicySchema.shape.softwareSources.optional(),
  exclude: AgentPolicyExcludeSchema.partial().optional(),
  softwareMax: AgentPolicySchema.shape.softwareMax.optional(),
});
export type AgentPolicyOverride = z.infer<typeof AgentPolicyOverrideSchema>;

/**
 * What the policy admin endpoints return: the stored layer an operator EDITS, the instance-wide
 * revision, and the layer RESOLVED so the UI can show what a host actually ends up with rather than
 * making the operator do the merge in their head.
 *
 * `effective` is honest about its scope, and the honesty matters: for `GET /infra/agent-policy` it is
 * the instance default resolved on its own, so a host that also has a service-account or node
 * override will NOT get exactly this. The UI says so where it renders it.
 */
export const AgentPolicySettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  settings: AgentPolicyOverrideSchema,
  effective: AgentPolicySchema,
});
export type AgentPolicySettings = z.infer<typeof AgentPolicySettingsSchema>;

/**
 * Flatten the scope layers into one complete policy — LATER LAYERS WIN, so callers pass them
 * least-specific first: `[instanceDefault, serviceAccount, node]`.
 *
 * THREE LEVELS AND NO GROUP MACHINERY (#1140). Per-node is the post-confirm override; per-service-
 * account is the natural anchor BEFORE a node exists, since the "Add a server" wizard mints one SA
 * per agent; the instance default covers the rest. There are deliberately no tags, groups, behaviours
 * or dynamic membership: at 5–20 people and a few dozen hosts, "instance default plus one override"
 * covers essentially every case, and when it stops, one `tag: string[]` on the node and one join is
 * the answer — not a rules engine.
 *
 * Merging is PER FIELD, not per group: a node override that sets `collect.containers` does not blank
 * the instance's `collect.software`. Exclusion LISTS are the exception and REPLACE wholesale, because
 * a merge-by-union would leave an operator unable to shorten a list at a narrower scope — the one
 * edit that scope exists for.
 */
export function resolveAgentPolicy(
  revision: number,
  layers: readonly (AgentPolicyOverride | undefined | null)[],
): AgentPolicy {
  const resolved: AgentPolicy = {
    ...AGENT_POLICY_DEFAULT,
    revision,
    collect: { ...AGENT_POLICY_DEFAULT.collect },
    softwareSources: [...AGENT_POLICY_DEFAULT.softwareSources],
    exclude: {
      nicNames: [...AGENT_POLICY_DEFAULT.exclude.nicNames],
      mountpoints: [...AGENT_POLICY_DEFAULT.exclude.mountpoints],
      softwareNames: [...AGENT_POLICY_DEFAULT.exclude.softwareNames],
    },
  };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.intervalSeconds !== undefined) resolved.intervalSeconds = layer.intervalSeconds;
    if (layer.staleAfterSeconds !== undefined) resolved.staleAfterSeconds = layer.staleAfterSeconds;
    if (layer.softwareMax !== undefined) resolved.softwareMax = layer.softwareMax;
    if (layer.softwareSources !== undefined) resolved.softwareSources = [...layer.softwareSources];
    if (layer.collect) resolved.collect = { ...resolved.collect, ...layer.collect };
    if (layer.exclude) {
      const { nicNames, mountpoints, softwareNames } = layer.exclude;
      if (nicNames !== undefined) resolved.exclude.nicNames = [...nicNames];
      if (mountpoints !== undefined) resolved.exclude.mountpoints = [...mountpoints];
      if (softwareNames !== undefined) resolved.exclude.softwareNames = [...softwareNames];
    }
  }
  return resolved;
}

// ── The local veto (hard rule 1) ──────────────────────────────────────────────────────────────────

/**
 * The limits a HOST's own config file may impose on any policy the server sends it. Every field here
 * is one-directional by construction — there is no shape in this interface that can loosen anything.
 */
export interface AgentLocalLimits {
  /** Only `false` has any effect: a local `true` cannot re-enable a collector the server turned off. */
  collect?: Partial<AgentPolicyCollect>;
  /** A FLOOR on cadence — the host may report less often than the server asks, never more often. */
  minIntervalSeconds?: number;
  /** A CEILING on the package cap — the host may report fewer packages, never more. */
  softwareMax?: number;
  /** Extra exclusions, UNIONED with the server's. Adding an exclusion can only ever narrow. */
  exclude?: Partial<AgentPolicyExclude>;
}

/**
 * Union the server's glob list with the host's own, de-duplicated and bounded by the schema's cap.
 *
 * **THE HOST'S ENTRIES COME FIRST, and that ordering is the rule rather than a style choice.** The
 * union has to be truncated somewhere — the result must stay a valid {@link AgentPolicySchema} value,
 * whose lists cap at {@link AGENT_POLICY_GLOBS_MAX} — and a `Set` preserves insertion order, so
 * whichever side is inserted first is the side that survives. Server-first meant a policy that filled
 * the cap silently discarded every exclusion the HOST had asked for, i.e. a server-supplied value
 * widening what a root agent reports: precisely what hard rule 1 says cannot happen. What gets dropped
 * at the cap is therefore the server's, and dropping one of those can only ever make a host report
 * MORE than the server asked for — never more than its own owner allowed.
 *
 * A host whose own list alone exceeds the cap keeps its first {@link AGENT_POLICY_GLOBS_MAX} patterns
 * and loses the rest. That is the same limit the policy schema states, and the person who can see and
 * shorten that file is the host owner themselves.
 */
function unionGlobs(server: readonly string[], local: readonly string[] | undefined): string[] {
  if (!local?.length) return [...server].slice(0, AGENT_POLICY_GLOBS_MAX);
  return [...new Set([...local, ...server])].slice(0, AGENT_POLICY_GLOBS_MAX);
}

/**
 * Intersect a server policy with the host's own limits (#1140, hard rule 1): **local may VETO, never
 * WIDEN.**
 *
 * If `/etc/lazyit-agent/config` says `COLLECT_SOFTWARE=false`, no policy from any server can turn it
 * back on. lazyit is self-hosted, and the person who owns the host is frequently not the person who
 * administers lazyit; a central config channel that could silently expand what a root agent reads
 * would be asking one of them to trust the other unconditionally. It is documented to operators as a
 * selling point, not smuggled in as an escape hatch.
 *
 * The result is always a VALID {@link AgentPolicySchema} value: the interval floor is clamped to the
 * schema's own maximum and a negative local cap clamps to zero, so a nonsense local file degrades to
 * a strict-but-legal policy rather than one the agent would refuse to apply.
 */
export function applyAgentPolicyVeto(policy: AgentPolicy, local: AgentLocalLimits): AgentPolicy {
  const collect = { ...policy.collect };
  for (const key of Object.keys(collect) as (keyof AgentPolicyCollect)[]) {
    // ONLY a local `false` matters. `&&` is the entire rule: off stays off, on defers to the server.
    if (local.collect?.[key] === false) collect[key] = false;
  }
  const floor = local.minIntervalSeconds;
  const intervalSeconds =
    floor !== undefined && floor > policy.intervalSeconds
      ? Math.min(floor, AGENT_POLICY_INTERVAL_MAX_SECONDS)
      : policy.intervalSeconds;
  const cap = local.softwareMax;
  const softwareMax =
    cap !== undefined && cap < policy.softwareMax ? Math.max(cap, 0) : policy.softwareMax;
  return {
    ...policy,
    intervalSeconds,
    softwareMax,
    collect,
    exclude: {
      nicNames: unionGlobs(policy.exclude.nicNames, local.exclude?.nicNames),
      mountpoints: unionGlobs(policy.exclude.mountpoints, local.exclude?.mountpoints),
      softwareNames: unionGlobs(policy.exclude.softwareNames, local.exclude?.softwareNames),
    },
  };
}

// ── The tick gate (the interval inversion) ────────────────────────────────────────────────────────

/**
 * A deterministic per-machine offset, in seconds, SUBTRACTED from this host's interval.
 *
 * WHAT IT BUYS, precisely — and this is narrower than "it spreads the estate", which is what an
 * earlier version of this comment claimed: **it absorbs scheduler slack.** The agent only ever wakes
 * on the tick, and a tick that lands a hair SHORT of the interval (systemd's `AccuracySec`, the
 * previous run's own duration, `OnUnitActiveSec` re-arming from activation rather than from the
 * report) would otherwise not be due, and the host would wait a whole extra tick. Subtracting a few
 * seconds to a couple of minutes makes that tick report instead.
 *
 * IT DOES NOT SPREAD AN ESTATE, which is what an earlier version of this comment claimed. The gate is
 * only ever evaluated ON a tick, so the due instant is QUANTIZED to one: an offset smaller than a
 * tick can move a host's report by a whole tick or by nothing at all, never by the smooth few-seconds
 * de-phasing "spreading" implies — and at the 900 s default, and at every round value the minutes-only
 * editor makes natural, the interval is an exact multiple of the tick, so there is no sub-tick
 * position for a host to be nudged into. The two-valued outcome it DOES produce is the useful one
 * above: a host whose lag exceeds its own offset waits the extra tick, one whose offset covers its lag
 * does not. Hosts that genuinely need to be de-phased are de-phased by their own timers —
 * `OnUnitActiveSec` re-arms from each host's own last activation, so its phase follows that host's
 * boot instant and run durations — and not by this function. It is not a reboot-window fix either:
 * that case is handled by the state file SURVIVING the reboot — a host that reported four minutes
 * before it went down is still not due when it comes back.
 *
 * SUBTRACTED, NEVER ADDED, and that direction is load-bearing rather than cosmetic. Adding it would
 * push the due instant PAST a scheduler tick whenever the tick and the interval are close — the exact
 * shape of a host that upgraded its binary without re-running `install.sh`, where the timer is still
 * on the old 15-minute `OnUnitActiveSec` and the interval is the 15-minute default. That host would
 * miss every other tick and quietly report half as often as configured. Being due slightly EARLY has
 * no such failure mode: the tick simply catches it.
 *
 * THE BOUND, stated as the code computes it: the span is half the SMALLER of the tick and the
 * interval, so the offset is at most 149 s on any interval of 300 s or more. On the 900 s default
 * that is an effective cadence of at least 751 s — 83.4% of what was asked for — and at the 300 s
 * minimum at least 151 s, so no cadence is ever cut to half or below.
 *
 * FNV-1a over the machine id: a few lines, no dependency, and stable across runs and versions. The
 * stability is what matters — an offset that moved between releases would silently change a host's
 * effective cadence on every upgrade, and would make "why did this host report then?" irreproducible
 * for whoever is debugging it. It is not a security primitive and is not used as one.
 */
export function policyJitterSeconds(machineId: string, intervalSeconds: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < machineId.length; i += 1) {
    hash ^= machineId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Bounded by half the TICK, never by the interval: the offset only has to cover the slack between
  // a tick and the interval it is a hair short of, and a larger one would meaningfully shorten a
  // 5-minute cadence. `intervalSeconds` is in the `Math.min` for defence only — the schema floors the
  // interval AT the tick, so on any policy this module produces the smaller value is always the tick.
  const span = Math.max(1, Math.floor(Math.min(AGENT_POLICY_TICK_SECONDS, intervalSeconds) / 2));
  return hash % span;
}

/** Everything {@link agentPolicyDue} needs. `lastSuccessMs` is undefined when there is no state file. */
export interface AgentPolicyDueInput {
  nowMs: number;
  /** The instant of the last SUCCESSFUL report, from the agent's local state file. */
  lastSuccessMs: number | undefined;
  policy: AgentPolicy;
  /** The dedup machine id — the jitter seed, so the offset is stable for the life of the install. */
  machineId: string;
}

/**
 * Is this tick a REPORT or a NO-OP? The one function the interval inversion rests on.
 *
 * The scheduler fires every {@link AGENT_POLICY_TICK_SECONDS} on every platform and never changes;
 * cadence is enforced HERE, against a local state file, which is why the server can move a fleet from
 * 5 minutes to 24 hours without a single unit file being rewritten.
 *
 * Two degenerate cases, both deliberately biased toward REPORTING:
 *  - **No state at all** (first run ever, or the file was deleted): report. A fresh install must show
 *    up in the tray immediately, not up to an interval later.
 *  - **A last-success in the FUTURE** (an NTP correction, a restored snapshot, a VM whose clock was
 *    rolled back): report. Waiting for the clock to catch up could silence a host for hours, and a
 *    silent host reads as an outage on the map — a worse failure than one extra report.
 */
export function agentPolicyDue({
  nowMs,
  lastSuccessMs,
  policy,
  machineId,
}: AgentPolicyDueInput): boolean {
  if (lastSuccessMs === undefined) return true;
  const elapsedMs = nowMs - lastSuccessMs;
  if (elapsedMs < 0) return true;
  const dueAfterSeconds =
    policy.intervalSeconds - policyJitterSeconds(machineId, policy.intervalSeconds);
  return elapsedMs >= dueAfterSeconds * 1000;
}
