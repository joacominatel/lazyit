import { z } from "zod";
import {
  AgentChassisSchema,
  AgentOsFamilySchema,
  InfraNodeKindSchema,
  InfraNodeStatusSchema,
} from "./infra";
import { isMajorBehind, isNewerVersion, parseSemver } from "../utils/semver";
import { pageSchema } from "./pagination";

/**
 * The agent fleet read surface (ADR-0094 §3/§4, issue #1206) — "how many agents do I have, on what
 * versions, who has not checked in, and who is degraded?".
 *
 * A READ and nothing else. Every field below is derived from data the server already stores —
 * `InfraNode.agentVersion` (#907's column), `lastReportedAt`, `status`, the `diagnostics` block inside
 * `specs`, and `ServiceAccount.lastUsedAt`. There is **no migration, no schema change and no contract
 * change** behind this file: assisted update (ADR-0094 shape B) computes what the operator needs from
 * what is already there and hands them a command; it pushes nothing to any host.
 *
 * The version comparison is NOT redefined here. There is exactly one notion of version ordering in
 * this codebase — `isNewerVersion` / `isMajorBehind` in `utils/semver` — and {@link agentVersionBucket}
 * is a pure re-expression of the two of them as one exclusive label. In particular the FAIL-SOFT
 * posture is inherited verbatim: either side unparseable ⇒ never "behind". `dev` (a source checkout,
 * or — until #1203 — every Docker-served binary) and an odd tag land in `unknown`, never in a bucket
 * that nags. What ADR-0094 §3 changes is only that `unknown` becomes a VISIBLE bucket with its own
 * count instead of silence, because an unstamped agent being indistinguishable from a current one is
 * what made the shipped #907 badge quietly useless.
 */

// ── The version buckets (ADR-0094 §3) ─────────────────────────────────────────────────────────────

/**
 * Which version bucket one agent-bearing node falls in. EXCLUSIVE — every node gets exactly one, so
 * the four counts sum to the fleet total and a distribution reads without double counting.
 *
 *   - `majorBehind` — the #907 contract-break tier (`isMajorBehind`). The ONLY tier allowed to
 *     produce a badge, a colour or an interruption (ADR-0094 §3/§8; ADR-0083's MAJOR-only nag rule).
 *   - `behind`      — strictly behind but within the same MAJOR (a MINOR/PATCH gap). Expected drift:
 *     it belongs in the table, never in a nag.
 *   - `unknown`     — a side did not parse. `dev`, unstamped, or an odd tag. NOT "behind" and never
 *     treated as one; an update prompt on a guess is worse than silence.
 *   - `current`     — both sides parsed and the agent is not behind (equal, or ahead — a host rebuilt
 *     mid-upgrade is legitimately ahead of the instance for a moment).
 */
export const AgentVersionBucketSchema = z.enum([
  "majorBehind",
  "behind",
  "unknown",
  "current",
]);
export type AgentVersionBucket = z.infer<typeof AgentVersionBucketSchema>;

/**
 * Bucket one agent's reported version against the instance's running version (ADR-0094 §3).
 *
 * PURE, and deliberately a thin re-expression of the two shared helpers rather than a second notion of
 * "behind": `majorBehind` IS `isMajorBehind(agentVersion, serverVersion)`, `behind` IS
 * `isNewerVersion(serverVersion, agentVersion)` minus the MAJOR tier, and anything either helper
 * cannot compare is `unknown`. Argument order matters and is easy to invert — `isMajorBehind` takes
 * (client, server) while `isNewerVersion` takes (candidate, current) — which is one more reason this
 * lives in one place with a test rather than being re-derived per surface.
 *
 * Read-tolerant by construction: `null`/`undefined`/`""` on either side answers `unknown`.
 */
export function agentVersionBucket(
  agentVersion: string | null | undefined,
  serverVersion: string | null | undefined,
): AgentVersionBucket {
  // MAJOR first: it is a strict subset of "behind", and it is the tier that is allowed to speak.
  if (isMajorBehind(agentVersion, serverVersion)) return "majorBehind";
  if (isNewerVersion(serverVersion, agentVersion)) return "behind";
  // Both helpers answered false. That is either "cannot compare" or "not behind" — and telling those
  // two apart is the whole point of the `unknown` bucket existing.
  if (!parseSemver(agentVersion) || !parseSemver(serverVersion)) return "unknown";
  return "current";
}

// ── Collector diagnostics, as the fleet view reads them (ADR-0094 §4) ─────────────────────────────

/**
 * What the collector could NOT do on its last run (#1138), projected out of the node's stored `specs`
 * blob. This is what lets a row say *"web-03: reporting unprivileged — no serial/model"* instead of
 * leaving the operator staring at an empty column wondering whether the host is broken or the agent
 * is.
 *
 * `privileged` is a TRI-STATE on purpose: `null` means the agent said nothing (a pre-#1138 collector),
 * which is "no signal", not "unprivileged". Only an explicit `false` is a degradation.
 */
export const AgentFleetDiagnosticsSchema = z.object({
  /** Did the collector run with root/SYSTEM? `null` when the agent did not say. */
  privileged: z.boolean().nullable(),
  /** Collectors that timed out or were skipped for lack of privilege. Capped by the report contract. */
  warnings: z.array(z.string()),
});
export type AgentFleetDiagnostics = z.infer<typeof AgentFleetDiagnosticsSchema>;

/**
 * Is this node DEGRADED — did its last report come back incomplete? True when the collector named at
 * least one warning, or explicitly reported that it ran unprivileged.
 *
 * PURE, so the web can re-evaluate it over a filtered set without a second request. Absent
 * diagnostics answer `false`: "the agent told us nothing" is not evidence of degradation.
 */
export function isAgentDegraded(
  diagnostics: AgentFleetDiagnostics | null | undefined,
): boolean {
  if (!diagnostics) return false;
  return diagnostics.privileged === false || diagnostics.warnings.length > 0;
}

// ── One row of the fleet view ─────────────────────────────────────────────────────────────────────

/**
 * One agent-bearing HOST on the fleet view.
 *
 * `osFamily` is the ADR-0090 display-only COMPUTED READ FIELD (ADR-0094 §5): it lives inside the
 * stored `specs` blob, and `specs` is deliberately off list projections (#1135, because on a real
 * Linux box it is the whole installed-software inventory). So the fleet read projects that ONE string
 * server-side and puts it on the row — no column, no migration, never a gate. It is what lets the web
 * build the correctly-flagged per-platform install command (§5) from evidence rather than a guess; a
 * `null` family means the UI must show BOTH commands with a note, never pick one (#1168).
 *
 * CONTAINER children are NOT rows here. A container inherits its host's `agentVersion` on every report
 * (it does not run an agent of its own), so counting them would inflate every bucket by however many
 * containers a host happens to run.
 */
export const AgentFleetNodeSchema = z.object({
  id: z.cuid(),
  /** The canvas display name — always wins for display (ADR-0070 §5). */
  label: z.string(),
  kind: InfraNodeKindSchema,
  /** Liveness as the staleness sweeper maintains it (ADR-0074 §4): OFFLINE = has not reported lately. */
  status: InfraNodeStatusSchema,
  /** Still in the PENDING review tray? A host that reported but has not been confirmed yet. */
  pending: z.boolean(),
  /** The linked Asset's inventory name; null when graph-only or the asset is soft-deleted. */
  assetName: z.string().nullable(),
  ipAddress: z.string().nullable(),
  /** The reporting agent's own build at its last check-in. Null on a pre-stamp agent. */
  agentVersion: z.string().nullable(),
  /** Which bucket {@link agentVersionBucket} put it in, against the instance's running version. */
  versionBucket: AgentVersionBucketSchema,
  /** Projected from `specs.host.os.family` (#1138). Null when the blob carries no usable family. */
  osFamily: AgentOsFamilySchema.nullable(),
  /** The agent-owned form factor (ADR-0093) — already a list-row scalar, carried through as-is. */
  chassis: AgentChassisSchema.nullable(),
  /** The dedup scope + platform identity key the node was enrolled under (ADR-0074 §2). */
  reportingSource: z.string().nullable(),
  lastReportedAt: z.iso.datetime().nullable(),
  /** Projected from `specs.diagnostics` (#1138). Null when the last report carried none. */
  diagnostics: AgentFleetDiagnosticsSchema.nullable(),
  /** {@link isAgentDegraded} over `diagnostics`, computed once server-side. */
  degraded: z.boolean(),
  /**
   * When the host was RETIRED (#1701) — gone, not silent. A retired row stays in the table (with a
   * badge) because its history is still worth reading, but {@link summarizeAgentFleet} counts it
   * under `retired` only: a decommissioned server is not an agent that is behind or not reporting.
   * `.nullish()` for an older API, which reads as active.
   */
  retiredAt: z.iso.datetime().nullish(),
  /** Offline alerts snoozed until this instant (#1701); see `isAlertsSnoozed`. Display only here. */
  alertsSnoozedUntil: z.iso.datetime().nullish(),
});
export type AgentFleetNode = z.infer<typeof AgentFleetNodeSchema>;

// ── The distribution (ADR-0094 §8's summary line) ─────────────────────────────────────────────────

/**
 * The counts above the table — *"245 agents · 12 a MAJOR behind · 31 behind · 180 version unknown ·
 * 22 not reporting"* (ADR-0094 §8). A SUMMARY, not an alarm: it reads as a distribution because a
 * table an admin navigated to is not a nag.
 *
 * The four bucket counts are exclusive and sum to `total`. `notReporting` and `degraded` are
 * ORTHOGONAL to them — a host can be current AND silent — so they deliberately do not participate in
 * that sum.
 */
export const AgentFleetSummarySchema = z.object({
  /** Every agent-bearing host counted (container children excluded — see {@link AgentFleetNodeSchema}). */
  total: z.number().int().nonnegative(),
  majorBehind: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  /** `majorBehind + behind` — the ACTIONABLE set, the hosts §5's command is generated for. */
  behindTotal: z.number().int().nonnegative(),
  /** OFFLINE (the staleness sweeper flipped it) or never reported at all. Orthogonal to the buckets. */
  notReporting: z.number().int().nonnegative(),
  /** {@link isAgentDegraded} over the rows. Orthogonal to the buckets. */
  degraded: z.number().int().nonnegative(),
  /**
   * Retired hosts (#1701). They are rows but NOT in `total`, the buckets, `notReporting` or
   * `degraded` — none of those questions is meaningful about a host that is gone. Optional on the
   * wire so a summary from an older API still parses (it simply has none).
   */
  retired: z.number().int().nonnegative().optional(),
});
export type AgentFleetSummary = z.infer<typeof AgentFleetSummarySchema>;

/**
 * Tally a set of rows into the distribution. PURE — exported so the web can re-summarise a FILTERED
 * table client-side without a second request, and so the server and the web can never disagree about
 * what "31 behind" means.
 */
export function summarizeAgentFleet(
  nodes: readonly AgentFleetNode[],
): AgentFleetSummary {
  const active = nodes.filter((node) => !node.retiredAt);
  const summary: AgentFleetSummary = {
    total: active.length,
    majorBehind: 0,
    behind: 0,
    unknown: 0,
    current: 0,
    behindTotal: 0,
    notReporting: 0,
    degraded: 0,
    retired: nodes.length - active.length,
  };
  for (const node of active) {
    summary[node.versionBucket] += 1;
    if (node.status === "OFFLINE" || node.lastReportedAt === null) {
      summary.notReporting += 1;
    }
    if (node.degraded) summary.degraded += 1;
  }
  summary.behindTotal = summary.majorBehind + summary.behind;
  return summary;
}

// ── Agent identities that have never checked in (ADR-0094 §4 liveness) ────────────────────────────

/**
 * An agent CREDENTIAL, as the fleet view reads it: a live service account holding `infra:report`.
 *
 * This is the other half of liveness. A node row can only describe a host that has reported at least
 * once; a token minted by the "Add a server" wizard for a host that never checked in leaves NO node
 * behind, so without this the most common install failure is invisible. `lastUsedAt: null` on an
 * account minted three weeks ago is the actionable fact.
 *
 * There is deliberately no join to a node: the schema carries no ServiceAccount→InfraNode link and
 * ADR-0094 adds no column, so this stays a fleet-level list rather than a per-host claim the data
 * cannot support. Never carries a token, a hash or a prefix.
 *
 * SEPARATELY GATED. This is the service-account CREDENTIAL INVENTORY, and every other surface that
 * reads it (`/service-accounts`, all of it) is `settings:manage` — ADMIN-only. The fleet VIEW is
 * `infra:read`, which the default seed grants to MEMBER *and* VIEWER, so shipping the inventory on
 * that gate would silently widen who can enumerate agent credentials on an operator's next upgrade.
 * The server therefore omits this block entirely for a caller without `settings:manage` (INV-9's
 * `accessRules` mold), which is why it is OPTIONAL on the view below rather than required.
 */
export const AgentFleetIdentitySchema = z.object({
  id: z.cuid(),
  name: z.string(),
  /** Soft-disabled accounts still appear (an install failing because its token was disabled is a fact). */
  isActive: z.boolean(),
  /** Set best-effort on each successful authentication; null until the credential is first used. */
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AgentFleetIdentity = z.infer<typeof AgentFleetIdentitySchema>;

/**
 * How many agent identities the fleet read lists. A guard rail, not a page: an estate mints roughly one
 * per agent and this list exists to surface the never-used ones, so the read orders never-used first
 * and truncates rather than growing without bound.
 */
export const AGENT_FLEET_IDENTITY_LIMIT = 200;

// ── The whole read ────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /infra/agents/fleet` — the entire fleet view in one read (ADR-0094 §4).
 *
 * `serverVersion` is the instance's own running build (`APP_VERSION`, ADR-0083) — the thing every
 * bucket was computed against. It rides on the response rather than being re-fetched from
 * `GET /instance/version` so the table can never render a distribution against a version it did not
 * come from, and so a `"dev"` server (which makes every bucket `unknown`) is legible on the surface
 * instead of mysterious.
 *
 * TWO GATES, one response. The view itself is `infra:read`; the credential block
 * (`identities` + `identitiesNeverUsed`) is `settings:manage` on top, and is OMITTED — not emptied —
 * for a caller who lacks it. An empty array would read as "no agent tokens exist", which is a
 * different and false claim; absence is the honest one. A consumer MUST therefore treat both fields
 * as possibly-absent (they are also absent from an older server that predates the gate's addition,
 * and were absent again from a pre-#1206 server that had no fleet route at all).
 */
export const AgentFleetViewSchema = z.object({
  serverVersion: z.string().min(1),
  summary: AgentFleetSummarySchema,
  nodes: z.array(AgentFleetNodeSchema),
  /**
   * Live agent credentials, never-used first, capped at {@link AGENT_FLEET_IDENTITY_LIMIT} — an
   * INLINE PREVIEW, not the register (that is the Service accounts page). ABSENT unless the caller
   * holds `settings:manage` (see {@link AgentFleetIdentitySchema}).
   */
  identities: z.array(AgentFleetIdentitySchema).optional(),
  /**
   * How many live agent credentials have NEVER authenticated — the count worth a line above the
   * list. Counted over the WHOLE set, not over the capped `identities` preview: past the cap the two
   * diverge, and this is rendered as an absolute ("3 agent tokens have never been used"), so
   * deriving it from the truncated array would under-report a large estate down to the cap. ABSENT
   * on the same `settings:manage` gate as `identities` — the two always travel together.
   */
  identitiesNeverUsed: z.number().int().nonnegative().optional(),
});
export type AgentFleetView = z.infer<typeof AgentFleetViewSchema>;

// ── The software watchlist (#1684, split from epic #1146 item 4) ──────────────────────────────────

/**
 * The software watchlist — a short, operator-maintained list of package names, each answered with
 * ONE fleet-wide distribution: *"openssl: 11 hosts on 3.0.13, 2 hosts on 1.1.1w, 1 host missing,
 * 3 unknown"*. Computed on read from the package lists the agents already stored on their nodes
 * (`InfraNode.specs.software`); nothing new is collected and nothing travels toward a host.
 *
 * DISTRIBUTION ONLY (CEO decision Q12 on #1146). There is deliberately no version COMPARISON here —
 * no "outdated", no ordering of versions, no EOL flag and no CVE matching (that needs a live feed,
 * which the air-gapped promise of ADR-0074 §6 rules out). A version is an opaque string and the only
 * thing this module does with it is count hosts per distinct value. Nor is there any NORMALIZATION of
 * products — mapping forty spellings of one product to one entry is a data-curation business the
 * epic refused. A watch matches a package by its exact name, compared after
 * {@link normalizeSoftwareName}.
 */

/** Cap on a watched name — the report contract's own cap on a package name (`software[].name`). */
export const SOFTWARE_WATCH_NAME_MAX = 255;

/**
 * How many LIVE watches an instance may hold. A guard rail, not a quota: the feature exists for the
 * "10–30 packages you care about every Patch Tuesday", and each one is a GROUP BY over every host's
 * stored package list on every read — so the list endpoint stays unpaged and bounded instead.
 */
export const SOFTWARE_WATCH_LIMIT = 100;

/**
 * The ONE spelling a package name is compared in: whitespace runs collapsed to a single space, the
 * ends trimmed, lower-cased. PURE and idempotent. A watch STORES its name in this form (so uniqueness
 * among live watches is uniqueness of the normalized name), and a reported package matches a watch
 * when its name normalizes to the same string.
 *
 * Nothing more than that, on purpose: no stripping of architecture suffixes, versions or vendor
 * prefixes. `libssl3` and `libssl3:amd64`, or `Mozilla Firefox` and `Mozilla Firefox (x64 en-US)`,
 * are different names here — a Windows registry `DisplayName` often carries the version or the
 * architecture, and folding those is the product normalization this feature declines to own.
 */
export function normalizeSoftwareName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A watched name on the WRITE path: normalized first, then bounded, so `"  OpenSSL "` is stored as
 * `"openssl"` and a name that is only whitespace is a 400, not an empty watch.
 */
export const SoftwareWatchNameSchema = z
  .string()
  .max(SOFTWARE_WATCH_NAME_MAX * 4)
  .transform(normalizeSoftwareName)
  .pipe(z.string().min(1).max(SOFTWARE_WATCH_NAME_MAX));

/** `POST /infra/software-watches` — the whole body. Strict: there is nothing else to set. */
export const CreateSoftwareWatchSchema = z.strictObject({
  name: SoftwareWatchNameSchema,
});
export type CreateSoftwareWatch = z.infer<typeof CreateSoftwareWatchSchema>;

/**
 * Where one host stands for one watched package.
 *
 *   - `INSTALLED` — the host's last stored package list names it (at one or more versions).
 *   - `MISSING`   — the host's last stored package list does NOT name it. Only ever said about a host
 *     that HAS a stored list, i.e. one whose agent actually enumerated its packages.
 *   - `UNKNOWN`   — we cannot say. See {@link SoftwareWatchUnknownReasonSchema}. Never folded into
 *     `MISSING`: "nobody looked" is not "it is not there", and on a Patch-Tuesday view the difference
 *     is the whole point.
 */
export const SoftwareWatchPresenceSchema = z.enum(["INSTALLED", "MISSING", "UNKNOWN"]);
export type SoftwareWatchPresence = z.infer<typeof SoftwareWatchPresenceSchema>;

/**
 * Why a host is `UNKNOWN` for a watch.
 *
 *   - `NOT_COLLECTED` — the node stores NO package list. That is what software collection being off
 *     leaves behind, whatever turned it off: the agent policy at any scope (instance, service account
 *     or node, #1140), the host's own local veto (`LAZYIT_COLLECT_SOFTWARE=false`), or a collector
 *     that has never been able to enumerate. The server clears the stored list when a report says
 *     `softwareState: 'disabled'` (#1142), so the stored absence is the evidence, and it is the only
 *     evidence that covers every layer — a node carries no reporter attribution (#1134), so the
 *     service-account policy layer cannot be resolved per node on a read.
 *   - `EXCLUDED_BY_POLICY` — the host stores a list, the name is not on it, AND the name matches a
 *     `exclude.softwareNames` glob of the policy the server can resolve for that node (the instance
 *     default plus the node's own override). The agent was told not to report it, so its absence
 *     proves nothing.
 */
export const SoftwareWatchUnknownReasonSchema = z.enum(["NOT_COLLECTED", "EXCLUDED_BY_POLICY"]);
export type SoftwareWatchUnknownReason = z.infer<typeof SoftwareWatchUnknownReasonSchema>;

/**
 * One distinct version and how many hosts carry it. `version: null` is the bucket for packages the
 * agent listed without a version (or with an empty one). A host carrying two versions of one package
 * (two kernels, a multi-slot runtime) counts once in EACH bucket, so the buckets can sum to more than
 * `installed` — `installed` counts hosts, the buckets count host×version pairs.
 */
export const SoftwareWatchVersionCountSchema = z.object({
  version: z.string().nullable(),
  hosts: z.number().int().nonnegative(),
});
export type SoftwareWatchVersionCount = z.infer<typeof SoftwareWatchVersionCountSchema>;

/**
 * One watch's fleet-wide distribution. `installed + missing + unknown === hostsTotal`, always: every
 * host in the population lands in exactly one presence. `versions` is ordered by host count
 * (descending), then by the version string as plain text — a STABLE display order and nothing more;
 * it is not a version ordering and must never be read as "newest first".
 *
 * The population is every live, agent-reported HOST (container and hypervisor-guest children carry
 * no package list of their own; manual nodes have no agent), PENDING and OFFLINE ones included — an
 * offline host's last list is still the best evidence there is, and the host rows say how old it is.
 */
export const SoftwareWatchDistributionSchema = z.object({
  hostsTotal: z.number().int().nonnegative(),
  installed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  versions: z.array(SoftwareWatchVersionCountSchema),
});
export type SoftwareWatchDistribution = z.infer<typeof SoftwareWatchDistributionSchema>;

/**
 * A watch as stored. `name` is the normalized form ({@link normalizeSoftwareName}). `createdById` /
 * `createdByName` name the human who added it — both null when the author was deleted (the name is
 * only shown for a LIVE author, the auto-confirm rule's rule).
 */
export const SoftwareWatchSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  createdById: z.uuid().nullable(),
  createdByName: z.string().nullable(),
});
export type SoftwareWatch = z.infer<typeof SoftwareWatchSchema>;

/**
 * `GET /infra/software-watches` (one row per live watch, oldest first, at most
 * {@link SOFTWARE_WATCH_LIMIT}) and `GET /infra/software-watches/:id` — the watch plus its
 * distribution, computed on that read.
 */
export const SoftwareWatchSummarySchema = SoftwareWatchSchema.extend({
  distribution: SoftwareWatchDistributionSchema,
});
export type SoftwareWatchSummary = z.infer<typeof SoftwareWatchSummarySchema>;

/**
 * One host on a watch's drill-in (`GET /infra/software-watches/:id/hosts`). Deliberately lean — the
 * node's own drill-in is one click away for everything else.
 *
 * `versions` is non-empty only for `INSTALLED` (distinct values, in the same plain-text order as the
 * buckets; `null` = listed without a version). `unknownReason` is set only for `UNKNOWN`.
 * `inventoryCollectedAt` is the stored blob's own `reportedAt` — when the package list this row is
 * judged on was COLLECTED, which on a quiet host can be much older than `lastReportedAt` (the last
 * check-in), because an unchanged inventory is not rewritten (#1153). Null when the blob carries none.
 */
export const SoftwareWatchHostSchema = z.object({
  id: z.cuid(),
  label: z.string(),
  kind: InfraNodeKindSchema,
  status: InfraNodeStatusSchema,
  pending: z.boolean(),
  lastReportedAt: z.iso.datetime().nullable(),
  inventoryCollectedAt: z.iso.datetime().nullable(),
  presence: SoftwareWatchPresenceSchema,
  versions: z.array(z.string().nullable()),
  unknownReason: SoftwareWatchUnknownReasonSchema.nullable(),
});
export type SoftwareWatchHost = z.infer<typeof SoftwareWatchHostSchema>;

/** The paged host list — the house `Page<T>` envelope (ADR-0030). */
export const SoftwareWatchHostPageSchema = pageSchema(SoftwareWatchHostSchema);
export type SoftwareWatchHostPage = z.infer<typeof SoftwareWatchHostPageSchema>;

/**
 * Tally per-host presences into a distribution. PURE — the server builds every summary with it, and a
 * consumer can re-tally a filtered set without a second request. Version buckets come from the
 * `INSTALLED` rows' `versions`; `null` and `""` share the null bucket.
 */
export function summarizeSoftwareWatch(
  hosts: readonly Pick<SoftwareWatchHost, "presence" | "versions">[],
): SoftwareWatchDistribution {
  const distribution: SoftwareWatchDistribution = {
    hostsTotal: hosts.length,
    installed: 0,
    missing: 0,
    unknown: 0,
    versions: [],
  };
  const buckets = new Map<string | null, number>();
  for (const host of hosts) {
    if (host.presence === "INSTALLED") {
      distribution.installed += 1;
      const seen = new Set<string | null>();
      for (const raw of host.versions) {
        const version = raw === "" ? null : raw;
        if (seen.has(version)) continue;
        seen.add(version);
        buckets.set(version, (buckets.get(version) ?? 0) + 1);
      }
    } else if (host.presence === "MISSING") {
      distribution.missing += 1;
    } else {
      distribution.unknown += 1;
    }
  }
  distribution.versions = [...buckets.entries()]
    .map(([version, count]) => ({ version, hosts: count }))
    .sort((a, b) => b.hosts - a.hosts || compareVersionText(a.version, b.version));
  return distribution;
}

/**
 * The plain-text display order for version strings — `null` last, otherwise code-unit order. NOT a
 * version comparison (Q12): `10.0` sorts before `9.1` here, and that is fine, because nothing reads
 * meaning into the order beyond "the same every time".
 */
export function compareVersionText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
