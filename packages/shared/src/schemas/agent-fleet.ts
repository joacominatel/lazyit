import { z } from "zod";
import {
  AgentChassisSchema,
  AgentOsFamilySchema,
  InfraNodeKindSchema,
  InfraNodeStatusSchema,
} from "./infra";
import { isMajorBehind, isNewerVersion, parseSemver } from "../utils/semver";

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
  const summary: AgentFleetSummary = {
    total: nodes.length,
    majorBehind: 0,
    behind: 0,
    unknown: 0,
    current: 0,
    behindTotal: 0,
    notReporting: 0,
    degraded: 0,
  };
  for (const node of nodes) {
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
 */
export const AgentFleetViewSchema = z.object({
  serverVersion: z.string().min(1),
  summary: AgentFleetSummarySchema,
  nodes: z.array(AgentFleetNodeSchema),
  /** Live agent credentials, never-used first, capped at {@link AGENT_FLEET_IDENTITY_LIMIT}. */
  identities: z.array(AgentFleetIdentitySchema),
  /** How many of `identities` have never authenticated — the count worth a line above the list. */
  identitiesNeverUsed: z.number().int().nonnegative(),
});
export type AgentFleetView = z.infer<typeof AgentFleetViewSchema>;
