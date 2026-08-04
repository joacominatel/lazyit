import type {
  AgentFleetIdentity,
  AgentFleetNode,
  AgentFleetView,
  AgentOsFamily,
} from "@lazyit/shared";
import { AGENT_PLATFORMS, type AgentPlatform, agentUpdateCommand } from "./install-commands";

/**
 * The pure rules behind the agent fleet view (ADR-0094 §4/§5/§7, issue #1207) — which platform a
 * host's command is built for, what the table's filter means, and what "copy the whole behind-set"
 * actually puts on the clipboard.
 *
 * Out of the component for the usual reason: these are the claims an operator acts on at scale. A
 * wrong platform hands a PowerShell line to a Debian box (the wizard bug #1168 already fixed once),
 * and a wrong filter quietly hides the hosts that needed updating. Neither is something a component
 * can be held to; `fleet.test.ts` holds these.
 *
 * The version buckets themselves are NOT re-derived here — `agentVersionBucket` already computed
 * them server-side and rides on every row, and `summarizeAgentFleet` re-tallies a filtered set. This
 * module never second-guesses either.
 */

// ── Which command a host gets (ADR-0094 §5) ───────────────────────────────────────────────────────

/**
 * The platforms to offer for one host's reported OS family — **evidence, never a guess.**
 *
 * `linux` and `windows` map to the one command that can run there. EVERYTHING ELSE — `darwin`,
 * `bsd`, `other`, and a `null` family from a node whose stored blob carries none (a pre-#1138 agent,
 * a manual node, a host that has not re-reported since the projection existed) — returns BOTH, so
 * the UI shows both commands with a note rather than picking one.
 *
 * That asymmetry is deliberate: there is no agent binary for macOS or BSD (ADR-0074 §6 builds
 * linux and windows only), so a `darwin` row is not "show the macOS command", it is "lazyit does not
 * know what to run here — here is everything it has". Showing both is honest and costs a read;
 * guessing costs an operator a failed paste on a host they are already logged into.
 */
export function agentPlatformsFor(
  osFamily: AgentOsFamily | null | undefined,
): AgentPlatform[] {
  if (osFamily === "linux") return ["linux"];
  if (osFamily === "windows") return ["windows"];
  return [...AGENT_PLATFORMS];
}

/** True when the row's OS family did not identify a platform, so the UI must show both commands. */
export function agentPlatformIsAmbiguous(
  osFamily: AgentOsFamily | null | undefined,
): boolean {
  return agentPlatformsFor(osFamily).length > 1;
}

// ── The table's one filter ────────────────────────────────────────────────────────────────────────

/**
 * What the fleet table can be narrowed to. The four version buckets are the exclusive distribution
 * the summary counts; `notReporting` and `degraded` are ORTHOGONAL to them (a host can be current
 * and silent), which is why this is one flat list of views rather than two combinable dimensions.
 */
export const AGENT_FLEET_FILTERS = [
  "ALL",
  "majorBehind",
  "behind",
  "unknown",
  "current",
  "notReporting",
  "degraded",
] as const;
export type AgentFleetFilter = (typeof AGENT_FLEET_FILTERS)[number];

/**
 * Read the filter out of the URL. Total and biased toward showing MORE: any unrecognised value — a
 * typo, a stale bookmark, a link from a future release — degrades to `ALL` rather than erroring or
 * hiding rows. A filter that silently drops hosts is the one failure mode this view cannot have.
 */
export function agentFleetFilterFromParam(
  raw: string | null | undefined,
): AgentFleetFilter {
  return (AGENT_FLEET_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as AgentFleetFilter)
    : "ALL";
}

/**
 * Has this host gone quiet? OFFLINE (the staleness sweeper flipped it, ADR-0074 §4) or never
 * reported at all.
 *
 * The same rule `summarizeAgentFleet` counts `notReporting` by, restated here so the filter and the
 * summary above it can never disagree — and `fleet.test.ts` asserts that agreement over a mixed set
 * rather than trusting the restatement.
 */
export function isNotReportingNode(
  node: Pick<AgentFleetNode, "status" | "lastReportedAt">,
): boolean {
  return node.status === "OFFLINE" || node.lastReportedAt === null;
}

/** Everything the fleet table filters on: one free-text needle and one view. */
export interface AgentFleetQuery {
  q: string;
  filter: AgentFleetFilter;
}

/**
 * Narrow the rows. Client-side over the loaded array — the fleet read is unpaged for the same reason
 * the node list is (ADR-0070: the estate is small by design), so this is instant and costs no
 * request.
 *
 * The needle matches everything an operator would type looking for one host: its label, the linked
 * asset's inventory name, its IP, the version it reported, and the reporting source it enrolled
 * under. Case-insensitive; an empty needle matches everything.
 */
export function filterAgentFleetNodes(
  nodes: readonly AgentFleetNode[],
  { q, filter }: AgentFleetQuery,
): AgentFleetNode[] {
  const needle = q.trim().toLowerCase();
  return nodes.filter((node) => {
    if (filter === "notReporting") {
      if (!isNotReportingNode(node)) return false;
    } else if (filter === "degraded") {
      if (!node.degraded) return false;
    } else if (filter !== "ALL" && node.versionBucket !== filter) {
      return false;
    }
    if (!needle) return true;
    return [
      node.label,
      node.assetName,
      node.ipAddress,
      node.agentVersion,
      node.reportingSource,
    ].some((field) => field?.toLowerCase().includes(needle) ?? false);
  });
}

// ── The credential block's second gate (ADR-0094 §4, #1206) ──────────────────────────────────────

/** The credential inventory, once it is known to be present. */
export interface AgentFleetCredentialBlock {
  identities: readonly AgentFleetIdentity[];
  /** Counted over the WHOLE set server-side, not over the capped `identities` preview. */
  neverUsed: number;
}

/**
 * The agent CREDENTIAL inventory, or `null` when this caller was not given one.
 *
 * `GET /infra/agents/fleet` carries TWO gates in one response (#1206): the view itself is
 * `infra:read`, and `identities` + `identitiesNeverUsed` need `settings:manage` on top. For a caller
 * without it the server OMITS both fields rather than emptying them, and that distinction is the
 * whole reason this function exists.
 *
 * **Absent is not zero, and rendering it as zero would be a lie.** An empty list would render as
 * *"no agent tokens have never been used"* — a positive claim about credentials this viewer was
 * deliberately not shown. A MEMBER or VIEWER would read a clean bill of health for an inventory they
 * cannot see. So the whole card disappears instead: no empty state, no "0", no placeholder.
 *
 * Total over a partial response by construction. The two fields always travel together server-side,
 * but this treats EITHER one being absent as "no block" rather than trusting that — an older server,
 * a proxy that strips fields, or a future partial projection all land on the safe answer instead of
 * on `undefined.length`.
 */
export function agentFleetCredentialBlock(
  view: Pick<AgentFleetView, "identities" | "identitiesNeverUsed">,
): AgentFleetCredentialBlock | null {
  if (!view.identities || view.identitiesNeverUsed === undefined) return null;
  return { identities: view.identities, neverUsed: view.identitiesNeverUsed };
}

// ── The actionable set, and the bulk handoff (ADR-0094 §7) ────────────────────────────────────────

/**
 * Is there anything to update? `majorBehind` or `behind` — and NOTHING else.
 *
 * This is the only gate on the update affordance (ADR-0094 §8, following ADR-0084 §5): no dead
 * disabled button on a current host, and nothing at all on a host whose version could not be
 * compared. `unknown` is explicitly not actionable — an update prompt on a guess is worse than
 * silence, and on an estate that predates #1203 `unknown` is most of the fleet.
 */
export function isAgentUpdatable(
  node: Pick<AgentFleetNode, "versionBucket">,
): boolean {
  return node.versionBucket === "majorBehind" || node.versionBucket === "behind";
}

/** One host in the bulk handoff: what to call it, and whether its platform was actually known. */
export interface AgentFleetUpdateHost {
  label: string;
  /** `false` when the row's OS family was unknown, so this host appears under BOTH platforms. */
  osKnown: boolean;
}

/** The hosts to update on one platform, and the single command that updates any of them. */
export interface AgentFleetUpdateGroup {
  platform: AgentPlatform;
  command: string;
  hosts: AgentFleetUpdateHost[];
}

/**
 * Group the behind hosts by the platform their command is built for (ADR-0094 §7).
 *
 * The command is per-PLATFORM, not per-host — it carries no token and no host-specific value, so
 * nine Linux hosts share one line. That is what makes the bulk handoff a two-line artifact instead
 * of a generated inventory, and it is why lazyit does not emit playbooks: the operator who runs
 * Ansible already knows how to wrap one command better than a generator would guess.
 *
 * A host with an unknown OS family lands in BOTH groups, marked, for the same reason its row shows
 * both commands: the alternative is silently dropping it from an update list an operator is about to
 * trust, or guessing.
 *
 * Only actionable rows ({@link isAgentUpdatable}) participate. Groups with no hosts are omitted, so
 * an all-Linux estate never sees an empty PowerShell block.
 */
export function agentFleetUpdateGroups(
  nodes: readonly AgentFleetNode[],
  origin: string,
): AgentFleetUpdateGroup[] {
  const groups = AGENT_PLATFORMS.map<AgentFleetUpdateGroup>((platform) => ({
    platform,
    command: agentUpdateCommand(platform, origin),
    hosts: [],
  }));
  for (const node of nodes) {
    if (!isAgentUpdatable(node)) continue;
    const platforms = agentPlatformsFor(node.osFamily);
    for (const group of groups) {
      if (!platforms.includes(group.platform)) continue;
      group.hosts.push({
        label: oneLine(node.label),
        osKnown: platforms.length === 1,
      });
    }
  }
  return groups.filter((group) => group.hosts.length > 0);
}

/** Flatten a label to one line — a node label is free text, and this one goes into a comment. */
function oneLine(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

/** The already-translated lines the copied artifact is annotated with. */
export interface AgentFleetUpdateScriptCopy {
  /** What this is, e.g. *"lazyit agent update — 12 hosts behind (server 1.10.0)"*. */
  headline: string;
  /**
   * That the command needs no credential, no URL and no per-host substitution, because `--upgrade`
   * re-runs each host from the configuration it already holds (#1208).
   *
   * It used to say the opposite — *"export LAZYIT_TOKEN first"* — which is now not merely stale but
   * harmful: `--upgrade` refuses to share a run with `LAZYIT_TOKEN`, so an operator who followed the
   * old annotation would have every host in the artifact fail.
   */
  credentialNote: string;
  /** Which hosts this group's command is for, e.g. *"linux · 9 hosts: web-01, web-02, …"*. */
  hostsLine: (group: AgentFleetUpdateGroup) => string;
}

/**
 * The text the "Copy all" affordance puts on the clipboard (ADR-0094 §7) — **the whole integration
 * surface**, and deliberately not a playbook, a startup script or an Intune package. Those are
 * promises about systems this repo cannot test.
 *
 * Every annotation is a `#` comment, which is a comment in BOTH `sh` and PowerShell, so whichever
 * half an operator pastes into whichever shell, the commentary never executes. The copy strings come
 * in already translated: the artifact an operator hands to their colleagues reads in the language
 * they are working in, and this module stays free of the message catalog.
 *
 * It is NOT a runnable script and does not pretend to be one — it holds both platforms' commands at
 * once. It is the exact set of commands, annotated with exactly which hosts each one is for.
 */
export function agentFleetUpdateScript(
  groups: readonly AgentFleetUpdateGroup[],
  copy: AgentFleetUpdateScriptCopy,
): string {
  const blocks = groups.map(
    (group) => `# ${oneLine(copy.hostsLine(group))}\n${group.command}`,
  );
  return [
    `# ${oneLine(copy.headline)}`,
    `# ${oneLine(copy.credentialNote)}`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
