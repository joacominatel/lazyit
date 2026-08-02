import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  agentReportSkewPaths,
  containerExternalId,
  containerExternalIdPrefix,
  containerNodeStatus,
  diffContainerFacts,
  diffHostFacts,
  diffSoftwareFacts,
  disambiguateExternalId,
  hostIdentityEvidence,
  identityDiscriminator,
  inferNodeKind,
  isClonedMachineId,
  isNewerVersion,
  isPlausibleEdge,
  osFamily,
  primaryIp,
  sanitizeSerial,
  softwareFingerprint,
  type AgentContainer,
  type AgentOsFamily,
  type AgentPolicy,
  type AgentReport,
  type AgentReportAck,
  type AgentReportHost,
  type AgentSoftwarePackage,
  type AttachInfraSecret,
  type BulkConfirmInfraNodes,
  type BulkDiscardInfraNodes,
  type ConfirmInfraNode,
  type InfraBulkResponse,
  type InfraBulkResult,
  type CreateInfraEdge,
  type CreateInfraNode,
  type HostIdentityEvidence,
  type InfraEdgeKind,
  type InfraFactChangeDraft,
  type InfraIdentityMatch,
  type InfraImpactNode,
  type InfraImpactResponse,
  type InfraNodeChild,
  type InfraNodeKind,
  type InfraAutoConfirmCandidate,
  type InfraNodeFactChangeList,
  type InfraNodeState,
  type InfraNodeStatus,
  type InfraSecretRef,
  type UpdateInfraNode,
  INFRA_FACT_CHANGE_FACT_MAX,
  INFRA_FACT_CHANGE_PAGE_SIZE,
  INFRA_FACT_CHANGE_PAGE_SIZE_MAX,
} from '@lazyit/shared';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetsService } from '../assets/assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { ArticlesService } from '../articles/articles.service';
import { SecretManagerService } from '../secret-manager/secret-manager.service';
import { SearchService } from '../search/search.service';
import { projectInfraNode } from '../search/search.documents';
import { parsePageQuery } from '../common/parse-page-query';
import { appVersion } from '../common/export-provenance';
import type { Principal } from '../auth/principal';
import { InfraNodeEnrollmentLimiter } from './infra-node-enrollment.limiter';
import { NotificationsService } from '../notifications/notifications.service';
import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { AgentPolicyService } from './agent-policy.service';

/**
 * The 400 a RE-POINT gets (#1117) — `PATCH /infra/nodes/:id` with an `assetId` on a node that already
 * carries one. Written for the operator holding it, so it names what the re-point would leave behind
 * and the two-step that IS available to them: detach, then attach. It lives here rather than in the
 * shared contract because the rule needs the node's stored `assetId`, which only this layer reads —
 * `UpdateInfraNodeSchema` accepts any cuid and cannot tell a re-point from a first-attach.
 *
 * Exported so the spec asserts the message the caller actually receives, not a copy of it.
 */
export const INFRA_NODE_ASSET_REPOINT_ERROR =
  'This node already carries an asset, and a patch cannot swap it for another in one step: the current link would be dropped without the detach that cleans up after it, orphaning that asset if lazyit auto-created it — it would be left in inventory owned by nobody. Send `assetId: null` first to detach (an auto-created asset is soft-deleted, a pre-existing one is left intact and merely un-linked), then a second patch carrying the new `assetId`. Attaching an asset to a node that carries none is allowed directly. ADR-0070 §5.';

/**
 * The policy-related columns one report writes (#1140) — spread into the node `data` on every branch.
 * Every key is OPTIONAL and an absent key means "leave the stored value alone", which is what keeps a
 * pre-#1140 agent (and a policy resolution that failed) from ever clearing a good value.
 */
interface AgentPolicyWriteFields {
  /**
   * The staleness threshold this node was just SERVED — what the §4 sweeper judges it against.
   * Absent unless the report ECHOED a revision: an agent that predates the policy channel is not
   * running a served threshold, so its node keeps the `INFRA_AGENT_STALE_AFTER_MS` fallback.
   */
  policyStaleAfterSeconds?: number;
  /** The revision the agent ECHOED. Absent when the agent sent none (any pre-#1140 build). */
  policyRevision?: number;
  /** Stamped ONLY when the echoed revision CHANGED, so "applied 3 days ago" stays true. */
  policyAppliedAt?: Date;
}

/**
 * What a report says should happen to the node's stored software list (#1142) — the resolution of
 * `software` + `softwareState` into the ONE decision the write path needs.
 *
 * The three modes are the whole point of the field. `replace` is the old behaviour; `preserve` is what
 * an omitted-because-unchanged list must mean, and `clear` is what a policy that turned software
 * collection off must still mean. Collapsing `preserve` and `clear` — which is what a single absent
 * key did before this — gives an operator either a package list frozen months ago with nothing on
 * screen saying so, or an inventory that silently empties.
 */
type SoftwareDirective =
  | {
      mode: 'replace';
      software: NonNullable<AgentReport['software']>;
      /**
       * The fingerprint of that list, computed HERE and not taken from the wire. Taking the agent's
       * would make the write skip depend on the client sending one — so every pre-#1142 agent, and
       * every attacker, would rewrite the blob on every report and the skip would reach only clients
       * that opted into it. Computing it costs a few milliseconds over the list we were sent anyway.
       * (It buys independence from the client's COOPERATION, which is not the same as a bound on a
       * client that varies its report — see {@link InfraService.refreshKnownNode}.)
       */
      hash: string;
    }
  | {
      mode: 'preserve';
      /**
       * Whether the report said `softwareState: 'unchanged'` — that it HAS a list identical to its
       * last accepted one. True for that state and no other, so `unavailable` (and every state this
       * build does not recognise, which the schema lands there) reads false.
       *
       * They all preserve identically and differ in exactly one place: only `unchanged` is a claim to
       * HAVE a list, so only `unchanged` can be ASKED to prove it. Asking a collector that could not
       * enumerate to resend would be asking it, forever, for something it does not have.
       */
      claimsUnchanged: boolean;
      claimedHash?: string;
    }
  | { mode: 'clear' };

/**
 * Read a report's software answer (#1142). A PRESENT list always wins; the absence is interpreted by
 * `softwareState`, and by nothing else.
 *
 * A report carrying NEITHER key is a pre-#1142 agent and keeps the pre-#1142 reading — `clear` —
 * because that is the only reading under which #1140's `LAZYIT_COLLECT_SOFTWARE=false` still stops an
 * operator from staring at an inventory nobody collects. Every state this build DOES understand that
 * is not `disabled`, and every state it does NOT understand (the schema lands those on `unavailable`),
 * preserves. That asymmetry is deliberate: the destructive reading is reachable only from an explicit,
 * recognised instruction.
 *
 * The wire's `softwareHash` is read on ONE branch only — an omitted list, where it is the claim to be
 * corroborated. A list that arrived is fingerprinted here, by the same shared function the agent uses,
 * so what gets stored is always the server's own reading of what it stored.
 */
function softwareDirective(report: AgentReport): SoftwareDirective {
  if (report.software !== undefined) {
    return {
      mode: 'replace',
      software: report.software,
      hash: softwareFingerprint(report.software),
    };
  }
  if (
    report.softwareState === undefined ||
    report.softwareState === 'disabled'
  ) {
    return { mode: 'clear' };
  }
  return {
    mode: 'preserve',
    claimsUnchanged: report.softwareState === 'unchanged',
    ...(report.softwareHash !== undefined
      ? { claimedHash: report.softwareHash }
      : {}),
  };
}

/**
 * Should the ack ask this agent for its whole package list (#1142)? Answered the same way on the
 * create branch and the refresh branch, which is why it lives here rather than twice.
 *
 * **Least evidence means least trust.** The first shape of this asked only when a fingerprint had
 * ARRIVED and failed to corroborate — so a claim the server COULD check and that failed was answered,
 * while one it could NOT check was believed forever. That is the posture inverted: the node preserved
 * a list nobody had corroborated and never asked again. Worst case was the create branch, where a
 * brand-new node whose first report claimed `unchanged` with no fingerprint was created with no
 * software list at all and kept a permanently empty inventory — precisely the failure the three-state
 * enum exists to prevent. It is reachable from a hand-rolled client, and — not adversarially — from a
 * legitimate future agent whose fingerprint outgrows `AGENT_SOFTWARE_HASH_MAX`: that bound is a
 * `.catch(undefined)` rather than a rejection, so the agent's OWN `safeParse` strips the hash while
 * `softwareState: 'unchanged'` survives.
 *
 * So an `unchanged` claim is asked for the list unless the server can corroborate it. What that costs
 * the over-cap agent is one full list every other report — it answers by forgetting its cache, sends
 * everything, caches the fingerprint again, and claims `unchanged` again on the tick after. Sending
 * more than necessary is the only failure mode this contract accepts; the alternative was an inventory
 * that silently stayed empty.
 *
 * `unavailable` (and every state this build does not recognise, which the schema lands there) is NOT
 * asked, because it never claimed to have a list. A fingerprint that arrives beside one is still
 * checked, since a report that sent one is corroborable whatever it called itself.
 */
function softwareResendWanted(
  software: SoftwareDirective,
  stored: { hasSoftware: boolean; hash?: string },
): boolean {
  if (software.mode !== 'preserve') return false;
  if (software.claimedHash === undefined) return software.claimsUnchanged;
  return !stored.hasSoftware || stored.hash !== software.claimedHash;
}

/** The stored inventory blob, read back WITHOUT the package list (#1153). See {@link InfraService.storedNodeSpecs}. */
interface StoredNodeSpecs {
  /** Everything the node's `specs` holds except `software`; `undefined` when the node has no blob yet. */
  rest?: Record<string, unknown>;
  /** Whether the stored blob carries a `software` key at all — the one bit `rest` cannot answer. */
  hasSoftware: boolean;
  /** The corroborating identity the node last reported (#1141), read off the same row. */
  identity: HostIdentityEvidence;
}

/** What one report should do to a node's `specs` column, decided before anything is written (#1153). */
interface SpecsWritePlan {
  /** The blob to persist, or `undefined` when what is stored already says exactly this. */
  write?: AgentReportSpecsBlob;
  /** The blob the node HOLDS once this report lands — what a linked Asset must mirror. */
  effective: AgentReportSpecsBlob;
  /** Whether this report owns the Asset's `software` key, or must leave whatever is there alone. */
  softwareOwned: boolean;
  /** Ask the agent for a full software list on its next report (#1142). */
  resend: boolean;
}

/**
 * The agent-owned keys a HOST report mirrors onto its linked Asset — the node's effective blob minus
 * everything that describes the REPORT rather than the host.
 *
 * `software` is present only when this report OWNS it. On `preserve` it is absent from both this
 * object and the owned-key list, so the Asset's own copy is left exactly as it is: the node did not
 * decide anything about the package list this tick, and neither may the Asset.
 */
function hostAssetFacts(plan: SpecsWritePlan): Record<string, unknown> {
  return {
    host: plan.effective.host,
    reportedAt: plan.effective.reportedAt,
    ...(plan.softwareOwned && plan.effective.software !== undefined
      ? { software: plan.effective.software }
      : {}),
  };
}

/**
 * Are these two STORED package lists the same list, ordering aside (#1153)? The Asset-side answer to
 * the question `softwareFingerprint` already answers for the node.
 *
 * Both sides come out of a jsonb column, so neither is known to be a package list at all: a
 * hand-edited `specs` can put anything under `software`. Anything that is not an array of plain
 * objects answers `false` — which is "compare them by value", the conservative reading, and never a
 * throw on the report path.
 */
function sameSoftwareList(a: unknown, b: unknown): boolean {
  const packages = (value: unknown): AgentSoftwarePackage[] | undefined =>
    Array.isArray(value) &&
    value.every(
      (pkg) => typeof pkg === 'object' && pkg !== null && !Array.isArray(pkg),
    )
      ? (value as AgentSoftwarePackage[])
      : undefined;
  const left = packages(a);
  const right = packages(b);
  if (left === undefined || right === undefined) return false;
  return softwareFingerprint(left) === softwareFingerprint(right);
}

/**
 * What the node STILL HOLDS when a planned write is skipped (#1153) — the blob read back off the row,
 * minus the package list its projection strips.
 *
 * It exists because `effective` is what a linked Asset mirrors, and on a skipped write the node's
 * facts are the STORED ones. Handing the Asset this report's facts instead leaves it a report ahead
 * of its own node: two surfaces disagreeing about one host, and the Asset is the one an operator
 * reconciles from.
 *
 * `target` fills in the two REQUIRED keys when the stored blob is missing or hand-edited into a shape
 * that carries neither. That is the tolerant reading, not a preference: a row with no readable host
 * facts is one where nothing can diverge, because there is nothing stored to disagree with.
 */
function heldSpecs(
  stored: StoredNodeSpecs,
  target: AgentReportSpecsBlob,
): AgentReportSpecsBlob {
  const rest = stored.rest;
  if (rest === undefined) return target;
  const { host, reportedAt } = rest;
  return {
    ...(rest as Omit<AgentReportSpecsBlob, 'host' | 'reportedAt'>),
    host:
      typeof host === 'object' && host !== null && !Array.isArray(host)
        ? (host as AgentReportHost)
        : target.host,
    reportedAt: typeof reportedAt === 'string' ? reportedAt : target.reportedAt,
  };
}

/**
 * The blob keys that change on EVERY report while the INVENTORY does not (#1153) — stripped from both
 * sides before the stored blob and the incoming one are compared.
 *
 * `reportedAt` is when the collector ran and `diagnostics.durationMs` is how long it took; neither is
 * a fact about the host. Left in the comparison they would make every report differ from the last, so
 * the write could never be skipped and this whole change would buy nothing. Taken out, they are the
 * only two things that can go stale when a write IS skipped — which is why the stored `reportedAt`
 * means *when these facts were collected*, and liveness is answered by the node's own
 * `lastReportedAt` column, not by anything inside the blob.
 *
 * Everything else stays in, deliberately: a changed warning list, a changed `privileged` flag, a new
 * skew record and a collision marker are all real changes and all write. Skip only on a confident
 * match — a missed write leaves stale inventory, which is worse than a wasted one.
 */
function withoutVolatileReportFacts(
  blob: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...blob };
  delete rest.reportedAt;
  const { diagnostics } = rest;
  if (
    typeof diagnostics !== 'object' ||
    diagnostics === null ||
    Array.isArray(diagnostics)
  ) {
    return rest;
  }
  const steadyDiagnostics = { ...(diagnostics as Record<string, unknown>) };
  delete steadyDiagnostics.durationMs;
  return { ...rest, diagnostics: steadyDiagnostics };
}

/**
 * Cap on the fact-history rows ONE report may write for ONE node (#1143).
 *
 * The flood this bounds is real and ordinary: a host that was offline through two patch windows comes
 * back and its first report legitimately differs by a few thousand packages. 200 rows says *this host
 * changed a lot, here is a bounded sample* instead of turning one check-in into a few thousand inserts.
 * The slice is deterministic (host facts first, then packages by name), so it is the same 200 rows
 * whichever replica took the report.
 *
 * A container child cannot approach it — {@link diffContainerFacts} tracks two facts — so the whole
 * report is bounded by this plus twice `AGENT_CONTAINERS_MAX`, i.e. 400 rows, without any budget
 * having to be threaded through the container reconciliation.
 */
const INFRA_FACT_CHANGES_MAX_PER_REPORT = 200;

/**
 * The rolling window and ceiling of the PER-NODE cap (#1143) — the bound the per-report cap alone
 * does not give.
 *
 * `InfraReportRateLimitGuard` (#1134) allows 120 reports per service account per minute, and a caller
 * that varies its package list on every request would otherwise turn that into ~1.4M rows an hour on
 * one node. This ceiling makes it 500. It is checked with one COUNT, and ONLY on a report that
 * actually has rows to write — which for a legitimate estate is a handful of times a month per host,
 * so the steady-state cost of the cap is zero queries.
 *
 * THE COUNT MUST BE ANSWERABLE FROM AN INDEX, and that is not a detail. Its predicate is a RANGE on
 * `createdAt`, so `(nodeId, id)` cannot serve it — that index could only walk every row the node owns
 * and re-check each one. Nothing prunes this table, so the node holding the most rows is by definition
 * the abused one, and the mitigation would degrade to a scan exactly when it fires, on the report
 * ingest path. `(nodeId, createdAt)` is carried for this query alone; measured on postgres:18-alpine
 * at 2.16M rows for one node, on the SQL Prisma emits for this very `count`, it is an index-only
 * scan, 7 buffers, 0.11 ms, against a parallel seq scan, 18,374 buffers, 38.6 ms without it.
 *
 * Over the ceiling the rows are DROPPED, not queued and not deleted: this table is append-only
 * (ADR-0006), so the bound is on what goes in, never on what is already recorded. A node that hits it
 * is either under abuse or genuinely changing hundreds of times an hour, and in both cases the next
 * window records again.
 */
const INFRA_FACT_CHANGES_WINDOW_MS = 60 * 60 * 1000;
const INFRA_FACT_CHANGES_MAX_PER_NODE_WINDOW = 500;

/** The node columns + linked Asset name `projectInfraNode` needs (the search projection shape). */
const SEARCH_NODE_SELECT = {
  id: true,
  label: true,
  kind: true,
  status: true,
  state: true,
  ipAddress: true,
  asset: { select: { name: true } },
} as const;

/** Optional filters for listing nodes (ADR-0070). All AND-combine; soft-deleted nodes never surface. */
export interface InfraNodeFilters {
  kind?: InfraNodeKind;
  status?: InfraNodeStatus;
  /** CONFIRMED (live map) | PENDING (v2 review tray). */
  state?: InfraNodeState;
}

/**
 * Provenance marker stamped into an AUTO-CREATED backing Asset's `specs` (ADR-0070 §5). It is how the
 * detach flow tells an asset the node created itself (soft-delete it on detach) from one that
 * pre-existed and was merely linked (only un-link it). A `specs` flag, NOT a new column — ponytail:
 * the cheapest provenance that survives a round-trip and reuses the existing ADR-0007 jsonb posture.
 */
const INFRA_AUTO_ASSET_MARKER = '_infraAutoCreated';

/**
 * The identity-collision remedy, PER PLATFORM (#1141 + #1144).
 *
 * Two things differ by OS and both of them are in the message an operator reads first: the command
 * that gives a clone a fresh identity, and the NAME of the fact the two hosts collided on.
 *
 * - **Linux** collides on `/etc/machine-id`, and `systemd-firstboot --setup-machine-id` is what
 *   regenerates it (the documented reason that tool exists).
 * - **Windows** collides on `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, and
 *   `sysprep /generalize` is what regenerates *that* — the very property ADR-0074's Windows identity
 *   section names as the reason MachineGuid is a safer key than a baked machine-id. #1144 is what
 *   makes this branch reachable on Windows at all: once Windows hosts report, two machines cloned
 *   from one image collide here exactly as two Linux clones do, and a Linux-only sentence would hand
 *   that operator a command their OS does not have.
 *
 * The families lazyit ships no agent for (`darwin`, `bsd`, `other`) are deliberately ABSENT rather
 * than defaulted: naming a command for a platform this product has never run on is the same defect
 * wearing a different OS. They get the action with no command — see {@link identityConflictRemedy}.
 */
const IDENTITY_CONFLICT_REMEDY: Partial<
  Record<AgentOsFamily, { readonly command: string; readonly identity: string }>
> = {
  linux: {
    command: 'systemd-firstboot --setup-machine-id',
    identity: 'machine-id',
  },
  windows: { command: 'sysprep /generalize', identity: 'MachineGuid' },
};

/**
 * How the nudge opens, and what it calls the colliding fact, for the reporting host's OS family.
 *
 * The family comes from the report being ingested — {@link osFamily}, which defaults an `os`-less
 * pre-v2 report to `linux` because every agent that predates contract v2 was a Linux-only collector.
 * The PEER's family is deliberately not consulted as a second source: the remedy is one sentence, and
 * two hosts that collided on one identity value were cloned from one image.
 */
function identityConflictRemedy(family: AgentOsFamily): {
  lead: string;
  identity: string;
} {
  const remedy = IDENTITY_CONFLICT_REMEDY[family];
  return remedy
    ? {
        lead: `Run \`${remedy.command}\` on the clones`,
        identity: remedy.identity,
      }
    : {
        lead: 'Give each clone its own machine identity',
        identity: 'machine identity',
      };
}

@Injectable()
export class InfraService {
  private readonly logger = new Logger(InfraService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly articles: ArticlesService,
    private readonly secrets: SecretManagerService,
    private readonly search: SearchService,
    // The #1134 new-node enrollment throttle — charged on the ONE branch that grows the table.
    private readonly enrollment: InfraNodeEnrollmentLimiter,
    // The #1141 cloned-machine-id nudge — the ONE automatic action the collision detection takes.
    private readonly notifications: NotificationsService,
    // The #1145 operator-authored auto-confirm rules. Consulted on the CREATE branches ONLY (never on
    // a refresh, never on the clone branch) — that is what makes a saved rule non-retroactive.
    private readonly autoConfirm: InfraAutoConfirmService,
    // The #1140 policy channel — resolution only; every WRITE to a policy scope is a human route.
    private readonly agentPolicy: AgentPolicyService,
  ) {}

  /**
   * Fire-and-forget search sync for a node (ADR-0035 / ADR-0070 v1): re-read the node WITH its linked
   * Asset's name, project it, and upsert into the `infra` index. Un-awaited, never throws, no-op when
   * Meili is disabled — a search outage can never fail a domain write. Mirrors AssetsService exactly.
   * The re-read is what lets the projection carry the (joined) `assetName`; if the row vanished between
   * the write and this read (a racing soft-delete), there is simply nothing to index.
   */
  private async syncNodeToSearch(id: string): Promise<void> {
    const row = await this.prisma.infraNode.findFirst({
      where: { id },
      select: SEARCH_NODE_SELECT,
    });
    if (row) this.search.upsert('infra', projectInfraNode(row));
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a node. Asset linkage is DEFAULT-ON (ADR-0070 §5): unless `trackAsAsset` is `false`, the
   * node gets a backing Asset — an existing one when `assetId` is given, otherwise a freshly-created
   * minimal Asset (name = label, status = UNKNOWN) stamped with the auto-created provenance marker so
   * a later detach knows to soft-delete it. `trackAsAsset: false` makes a graph-only node (right for
   * ephemeral containers); passing both `assetId` and `trackAsAsset: false` is a contradiction → 400.
   */
  async createNode(
    data: CreateInfraNode,
    trackAsAsset: boolean,
    principal?: Principal,
  ) {
    if (!trackAsAsset && data.assetId !== undefined) {
      throw new BadRequestException(
        'Cannot pass an assetId while trackAsAsset is false — that is a contradiction (graph-only nodes have no asset).',
      );
    }

    let assetId: string | undefined = data.assetId;
    if (trackAsAsset) {
      if (data.assetId !== undefined) {
        // Link an existing asset — 404 (not silent) if it is missing/soft-deleted, so the node never
        // dangles a non-existent link. The asset is left fully intact (we only reference it).
        await this.assets.assertExists(data.assetId);
      } else {
        // No assetId → create a minimal backing Asset (ponytail: only the two REQUIRED fields, name +
        // status). Stamp the auto-created marker into specs for the detach-provenance check (§5). The
        // asset-create path emits its own CREATED history event + search sync (reused, not reinvented).
        const created = await this.assets.create(
          {
            name: data.label,
            status: 'UNKNOWN',
            specs: { [INFRA_AUTO_ASSET_MARKER]: true },
          },
          principal,
        );
        assetId = created.id;
      }
    }

    const { specs, shortcuts, ...rest } = data;
    const node = await this.prisma.infraNode.create({
      data: {
        ...rest,
        // `rest` carries the input `assetId` (possibly undefined); override with the resolved one
        // (the freshly-created asset id, or the same linked id). undefined => graph-only (no link).
        assetId: assetId ?? null,
        ...(specs !== undefined
          ? { specs: specs as Prisma.InputJsonValue }
          : {}),
        ...(shortcuts !== undefined ? { shortcuts } : {}),
      },
    });
    // Fire-and-forget search sync after the write (ADR-0035): un-awaited, never throws, no-op when
    // Meili is disabled. The helper re-reads with the linked Asset name for the projection.
    void this.syncNodeToSearch(node.id);
    return node;
  }

  /**
   * Ingest one server reporting-agent report (ADR-0074 §3) — the machine-facing upsert behind
   * `POST /infra/report`. Reconciles on the dedup key `(reportingSource, externalId)` over NON-deleted
   * nodes (the partial-unique index from migration 20260627130000):
   *
   *   - UNKNOWN key → CREATE a `source=AGENT`, `state=PENDING`, `status=ONLINE` node (a PROPOSAL in the
   *     review tray). `kind` defaults to `PHYSICAL_HOST`, `label` = hostname, `specs` = the inventory
   *     blob. NO backing Asset is created — the Asset is minted later, only on HUMAN confirmation.
   *   - KNOWN key → UPDATE `specs`, refresh `status=ONLINE` + `lastReportedAt`. It NEVER overwrites a
   *     human's curation (`state`, `label`, `x`/`y`, asset link, …): the agent owns inventory FACTS,
   *     the human owns curation. A confirmed node keeps receiving fresh facts without losing its edits.
   *
   * RACE-SAFE (#1012): the findFirst→create is a TOCTOU against the partial-unique dedup index, so two
   * concurrent reports from the SAME host (the install's report racing the systemd timer's first fire,
   * or a re-install) could both miss + both CREATE. The loser now catches the P2002 and falls back to
   * the SAME curation-preserving update — a repeat/concurrent report is IDEMPOTENT (ack), never a 409.
   *
   * Returns a minimal ack `{ nodeId, state, accepted: true }`. The post-write search sync reuses the
   * existing fire-and-forget helper.
   *
   * ponytail: no new BullMQ queue for MVP — reports are light; reuse the existing fire-and-forget
   * search sync, add a queue only if report volume ever makes the inline upsert slow.
   *
   * KIND IS NOW PROPOSED, NOT DEFAULTED (#1139). Contract v2 carries `host.virtualization` and
   * `host.chassis`, so the CREATE branch asks the shared `inferNodeKind` mapper what the host IS
   * instead of landing every one of them as `PHYSICAL_HOST` — a Proxmox host and its eight guests
   * used to arrive as nine identical boxes an operator re-classified by hand before blast radius
   * meant anything. A report with no evidence still lands on the old default, and the REFRESH branch
   * never touches `kind` at all: the server proposes on create, the human still confirms.
   *
   * TOPOLOGY, NOT JUST INVENTORY (#1139). When the report carries `host.containers`, each container
   * becomes a CONTAINER child node with an active `RUNS_ON` edge back to this host — see
   * {@link reconcileContainers}. That is the first thing the agent produces that the graph can
   * actually traverse.
   *
   * THROTTLED (#1134): the CREATE branch — the only branch that adds a row — first charges the
   * reporter's new-node enrollment budget ({@link InfraNodeEnrollmentLimiter}). The refresh branch is
   * deliberately never charged: a known host checking in adds nothing, so the legitimate agent (one
   * node, a report every 15 minutes) never touches this machinery at all — and a reporter that HAS
   * tripped the limit keeps refreshing the hosts the operator already has, so a tripped limit can
   * never manufacture a false outage on the topology map.
   *
   * The `principal` is used as an EPHEMERAL throttle key and is never persisted. ADR-0074 §8's #1136
   * correction still holds in full: no `InfraNode` write records which service account produced it.
   *
   * FORWARD-COMPATIBLE (#1138): `AgentReportSchema`'s root is no longer strict, so a report carrying
   * keys this build does not know DEGRADES (they are stripped, the host still lands) instead of
   * 400-ing — for a CMDB, a host vanishing from the inventory is strictly worse than a host that is
   * slightly stale on new fields. The signal is MOVED, not lost: pass the RAW body as `rawBody` and
   * everything the parse dropped or had to coerce, at any depth, is recorded on the node (see
   * {@link agentSkew}) and logged. Omitting `rawBody` simply records nothing.
   *
   * IT IS ALSO THE POLICY CHANNEL (#1140). The ack now carries the server-resolved configuration for
   * this exact agent (instance default < service account < node), and the agent's ECHOED
   * `policyRevision` — reserved but discarded until now — is persisted here. That echo is the whole
   * difference between having central configuration and believing you have it. Nothing about it can
   * fail a report: see {@link resolvePolicy}.
   */
  async ingestReport(
    report: AgentReport,
    principal?: Principal,
    rawBody?: unknown,
  ): Promise<AgentReportAck> {
    // The inventory blob (ADR-0074 §2 / ADR-0007 jsonb posture): host facts plus the report timestamp
    // for provenance. Stored verbatim — validated already by `AgentReportSchema` at the controller.
    // `agentVersion` is NOT duplicated here (#907): it now lives in its own queryable column below.
    // Held as a plain object (not just `Prisma.InputJsonValue`) so the linked-Asset specs sync can
    // spread its keys (#1081).
    //
    // `software` is deliberately NOT assembled here any more (#1142). Whether the package list is
    // replaced, kept or cleared depends on what the NODE already holds, which this method has not read
    // yet — so it is decided per branch, by {@link planSpecsWrite}.
    const skew = this.agentSkew(report, rawBody);
    // What this report says about the package list (#1142). It is resolved ONCE, here, so every
    // branch below — create, refresh, race, clone — reads the same answer instead of re-deriving one.
    const software = softwareDirective(report);
    const blob: AgentReportSpecsBlob = {
      host: report.host,
      reportedAt: report.reportedAt,
      // What the COLLECTOR could not do (#1138). Persisted beside the facts, because an empty
      // serial/model column is only an ANSWER ("web-03 reports unprivileged") if the reason survived
      // the request. It is part of what the write path COMPARES (#1153), exactly like the facts
      // themselves: a changed warning list or `privileged` flag is a real change and writes, an
      // identical one is skipped, and `durationMs` is excluded because it moves on every report
      // while nothing about the host does. When the blob is written it is replaced wholesale.
      ...(report.diagnostics !== undefined
        ? { diagnostics: report.diagnostics }
        : {}),
      ...(skew !== undefined ? { agentSkew: skew } : {}),
    };
    const now = new Date();
    // The primary IP promoted to the node's `ipAddress` (#1081) — IPv4 wherever the host has one, else
    // a routable IPv6 (#1138). A display fact, undefined on a partial/unprivileged report (then we
    // never fabricate or clear an IP).
    const primaryIpAddress = primaryIp(report.host);

    // Reconcile by the dedup key over non-deleted nodes (the soft-delete extension scopes findFirst).
    // `assetId`/`ipAddressSource` are selected so the KNOWN-key refresh can sync the linked Asset's
    // specs and honour a human's MANUAL IP (#1081).
    const existing = await this.prisma.infraNode.findFirst({
      where: {
        reportingSource: report.reportingSource,
        externalId: report.externalId,
      },
      select: {
        id: true,
        assetId: true,
        ipAddressSource: true,
        // `label` is read for the #1141 collision nudge only — it names the node the operator already
        // has, which is the whole difference between an actionable warning and a cryptic one.
        label: true,
        // The #1140 narrowest policy scope + the acknowledgement this report may advance.
        agentPolicy: true,
        policyRevision: true,
      },
    });

    // Resolved ONCE per report, before any branch, so the ack, the create and the refresh all agree
    // on the same generation. `undefined` when resolution failed — the report still lands.
    const policy = await this.resolvePolicy(principal, existing?.agentPolicy);

    if (existing) {
      // ONE read of the node's stored blob, serving both jobs (#1141 + #1153): the corroborating
      // identity the clone check needs, and everything the write planner has to compare against. The
      // package list is deliberately left in the database — see {@link storedNodeSpecs}.
      const stored = await this.storedNodeSpecs(existing.id);
      // CORROBORATE before merging (#1141). The dedup key is the host's identity value twice, so a
      // baked one — `/etc/machine-id` on Linux, `MachineGuid` on a Windows image `sysprep` never
      // generalized — makes every clone of a template match here and write to ONE row.
      const incoming = hostIdentityEvidence(report.host);
      if (isClonedMachineId(stored.identity, incoming)) {
        return this.ingestCollidingHost(
          existing,
          stored.identity,
          incoming,
          report,
          blob,
          software,
          now,
          primaryIpAddress,
          principal,
          policy,
        );
      }
      // Known host: refresh inventory facts + liveness ONLY. Curation (state/label/x/y/asset) is the
      // human's and is deliberately left untouched. NOT throttled — it adds no row (#1134).
      const samePolicyGeneration = this.samePolicyGeneration(
        report,
        existing.policyRevision,
      );
      const ack = await this.refreshKnownNode({
        node: existing,
        blob,
        software,
        now,
        agentVersion: report.agentVersion,
        primaryIpAddress,
        policyFields: this.policyWriteFields(
          report,
          existing.policyRevision,
          policy,
          now,
        ),
        samePolicyGeneration,
        stored,
      });
      return this.reconcileContainers(
        ack,
        report,
        now,
        samePolicyGeneration,
        principal,
        policy,
      );
    }

    // Unknown host ⇒ a NEW row. This is the only branch that can grow the table, so it is the only one
    // the enrollment throttle charges (#1134).
    this.enrollment.assertWithinBudget(principal);

    // New host: a PENDING proposal in the review tray. No backing Asset until a human confirms (§3).
    // Its `ipAddress` is seeded from the report (source=AGENT) so the topology card shows the IP with
    // zero hand-entry — an IP is a display fact; setting it pre-confirm does NOT bypass the human gate.
    // The PROPOSAL (#1139). `undefined` means the report carried no evidence — the probe did not run,
    // or the agent predates contract v2 — so the pre-#1139 default stands rather than a guess dressed
    // as a finding. Only the create branch reads this. Hoisted out of the `data` literal because the
    // #1145 rule matcher is asked about the kind the server PROPOSED, never one the agent chose.
    const proposedKind = inferNodeKind(report.host) ?? 'PHYSICAL_HOST';
    // A node that does not exist yet holds no package list, so there is nothing to preserve and
    // nothing to clear: the blob carries whatever this report actually sent (#1142). An agent that
    // arrives claiming `unchanged` — a re-installed host whose state file survived, or one whose node
    // an operator discarded and which has just been rediscovered — is asking us to keep a list we do
    // not have, so the ack asks it for the whole thing rather than leaving the new node's inventory
    // permanently empty until its packages happen to change.
    const createSpecs: AgentReportSpecsBlob = {
      ...blob,
      ...(software.mode === 'replace'
        ? { software: software.software, softwareHash: software.hash }
        : {}),
    };
    // A node that does not exist yet holds no list, so nothing an `unchanged` claim says about it
    // can corroborate — with a fingerprint or without one. See {@link softwareResendWanted}.
    const resend = softwareResendWanted(software, { hasSoftware: false });
    try {
      const created = await this.prisma.infraNode.create({
        data: {
          kind: proposedKind,
          label: report.host.hostname,
          status: 'ONLINE',
          source: 'AGENT',
          state: 'PENDING',
          reportingSource: report.reportingSource,
          externalId: report.externalId,
          lastReportedAt: now,
          agentVersion: report.agentVersion,
          ...(primaryIpAddress !== undefined
            ? { ipAddress: primaryIpAddress, ipAddressSource: 'AGENT' as const }
            : {}),
          // A brand-new node has no stored revision, so an agent that already echoes one is recorded
          // as having applied it from its very first report (#1140) — a re-installed host whose cache
          // survived must not read as "pending" forever.
          ...this.policyWriteFields(report, null, policy, now),
          specs: createSpecs,
        },
        select: { id: true, state: true },
      });
      void this.syncNodeToSearch(created.id);
      // The ONE place a saved rule can act on a HOST (#1145): a node that has just been proposed, in
      // the same request that proposed it. Nothing here can reach a node that already existed.
      const state = await this.autoConfirmProposal(
        created.id,
        created.state,
        {
          hostname: report.host.hostname,
          ipAddress: primaryIpAddress ?? null,
          kind: proposedKind,
          isContainerChild: false,
        },
        {
          reportingSource: report.reportingSource,
          externalId: report.externalId,
        },
      );
      return this.reconcileContainers(
        {
          nodeId: created.id,
          state,
          accepted: true,
          ...(resend ? { softwareResend: true } : {}),
        },
        report,
        now,
        // A node created a moment ago has no stored revision — the same `null` the policy columns
        // were just written against. Its own host facts have no baseline to diff anyway; a container
        // child rediscovered under a node that was discarded and re-proposed does, and it gets the
        // conservative answer.
        this.samePolicyGeneration(report, null),
        principal,
        policy,
      );
    } catch (err) {
      // Race: a concurrent report from the SAME host (the install's report racing the freshly-armed
      // systemd timer's first fire, or a re-install) inserted the dedup row between our findFirst and
      // this create → the partial-unique `infra_nodes_reporting_source_external_id_key` throws P2002.
      // The row now DEFINITIVELY exists, so re-resolve it and take the curation-preserving update path
      // — a repeat report from one host is IDEMPOTENT (200/ack), never a 409 (#1012).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.infraNode.findFirst({
          where: {
            reportingSource: report.reportingSource,
            externalId: report.externalId,
          },
          select: {
            id: true,
            assetId: true,
            ipAddressSource: true,
            policyRevision: true,
          },
        });
        // No loop: after P2002 the row exists. If it somehow doesn't (e.g. it was soft-deleted in the
        // same instant so findFirst can't see it), rethrow the original error rather than inventing one.
        if (raced) {
          const samePolicyGeneration = this.samePolicyGeneration(
            report,
            raced.policyRevision,
          );
          const ack = await this.refreshKnownNode({
            node: raced,
            blob,
            software,
            now,
            agentVersion: report.agentVersion,
            primaryIpAddress,
            policyFields: this.policyWriteFields(
              report,
              raced.policyRevision,
              policy,
              now,
            ),
            samePolicyGeneration,
          });
          return this.reconcileContainers(
            ack,
            report,
            now,
            samePolicyGeneration,
            principal,
            policy,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Resolve this agent's policy (#1140) — and NEVER let it fail the report.
   *
   * The try/catch is the whole method's reason to exist. Policy is configuration: a host that cannot
   * be configured this tick keeps its cached policy and tries again in fifteen minutes, which costs
   * nothing. A host whose REPORT 500s vanishes from the CMDB, shows OFFLINE on the map and nudges the
   * bell — the failure class ADR-0074's degrade-never-reject posture exists to prevent. So a broken
   * settings row, a DB hiccup or anything else degrades to an ack with NO `policy` key, which the
   * agent already treats as "keep what you have".
   */
  private async resolvePolicy(
    principal: Principal | undefined,
    nodeOverride: unknown,
  ): Promise<AgentPolicy | undefined> {
    try {
      return await this.agentPolicy.resolveForReport(principal, nodeOverride);
    } catch (err) {
      this.logger.warn(
        `Could not resolve the agent policy — the report was still accepted and the agent keeps its cached policy. ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * The LAST step of every ingest path: everything an ack says about THIS SERVER rather than about
   * this report — the resolved policy (#1140) and the software-delta capability (#1142). Applied here
   * rather than at each branch, so a branch added later cannot silently ship an ack that carries
   * neither.
   *
   * **`softwareDelta: true` is a statement about the BUILD, not about the request**, which is why it is
   * unconditional while `policy` is not. This server understands `softwareState`, so an omitted package
   * list is preserved rather than read as "no software" — and an agent may only start omitting once it
   * has SEEN that. The contract root is a loose `z.object()` (the #1138 decision that keeps a newer
   * agent from 400-ing itself off the map), so a server built before #1142 does not reject
   * `softwareState`/`softwareHash`; it silently STRIPS them, sees no `software` key and clears the
   * stored list — permanently, because the agent believes the list unchanged and never resends it.
   * `agentSkew` would RECORD that strip on the node; only this handshake prevents it. A failed policy
   * resolution must therefore never suppress this flag: that would un-teach every agent in the estate
   * over a settings row nobody could read.
   */
  private finishAck(
    ack: AgentReportAck,
    policy: AgentPolicy | undefined,
  ): AgentReportAck {
    return {
      ...ack,
      softwareDelta: true,
      ...(policy !== undefined ? { policy } : {}),
    };
  }

  /**
   * The policy columns this report writes (#1140). Every key is omitted rather than nulled when there
   * is nothing to say, so a pre-#1140 agent, or a tick whose resolution failed, can never CLEAR a good
   * stored value.
   *
   * `policyAppliedAt` moves only when the echoed revision CHANGES. Stamping it on every report would
   * make it a second `lastReportedAt` and destroy the one question it answers — *when did this host
   * pick the current config up?* — which is exactly what an operator asks after a fleet-wide change.
   *
   * `policyStaleAfterSeconds` is gated on the SAME echo, and that gate is the whole honesty of the
   * column: it records the staleness this node's agent is actually judged by, and an agent that
   * predates the policy channel never receives, caches or applies one — it reports on whatever
   * `install.sh` gave its timer and echoes nothing. Writing the resolved value for such a node would
   * silently override a deliberately tuned `INFRA_AGENT_STALE_AFTER_MS` for precisely the hosts the
   * env var is documented to still cover (a pre-#1140 agent, a manual row, a failed resolution).
   */
  /**
   * Did this report's facts and the node's STORED facts come out of the same #1140 policy generation
   * (#1143)? The answer the fact diff needs before it may call a difference a change.
   *
   * **Where the distinction is made, and why here.** The agent knows which packages its policy
   * filtered out; the server never sees them. But the server does not need the names — it only needs
   * to know that the FILTER moved, and it already holds that: the agent echoes the generation it
   * collected under in every report (`policyRevision`), and the node's column of the same name holds
   * that echo from its previous report. So no wire field is added and no query is made; the
   * comparison is two values already in hand, and an older agent needs no upgrade to be protected.
   *
   * **Both-absent is SAME, deliberately.** A pre-#1140 agent echoes nothing and applies no server
   * policy, so it can produce no policy artefact — and reading its two absences as "the generation
   * moved" would silence the package history of most of the fleet on the day this ships.
   *
   * **It is deliberately blunt in one direction.** The revision is instance-wide and bumps on ANY
   * policy write at any scope, so editing one host's policy makes every host in the estate skip its
   * policy-sensitive diff for one report. That is the safe direction to be wrong in: the cost is one
   * check-in's worth of disk/package rows and a baseline that re-seeds from the new list, against an
   * invented uninstall that would make the whole tab untrustworthy.
   *
   * **What it cannot see.** The host's own `/etc/lazyit-agent/config` may narrow the policy further
   * (`LAZYIT_EXCLUDE_SOFTWARE`, `LAZYIT_SOFTWARE_MAX` — the local VETO), and editing that file moves
   * no revision. Someone with root on the host editing the host's own filter is not the case this
   * table exists to protect; see the ADR-0074 §3 amendment for the residual and what closing it
   * would cost on the wire.
   */
  private samePolicyGeneration(
    report: AgentReport,
    storedRevision: number | null | undefined,
  ): boolean {
    return report.policyRevision === (storedRevision ?? undefined);
  }

  private policyWriteFields(
    report: AgentReport,
    storedRevision: number | null | undefined,
    policy: AgentPolicy | undefined,
    now: Date,
  ): AgentPolicyWriteFields {
    const echoed = report.policyRevision;
    return {
      ...(policy !== undefined && echoed !== undefined
        ? { policyStaleAfterSeconds: policy.staleAfterSeconds }
        : {}),
      ...(echoed !== undefined ? { policyRevision: echoed } : {}),
      ...(echoed !== undefined && echoed !== (storedRevision ?? undefined)
        ? { policyAppliedAt: now }
        : {}),
    };
  }

  /**
   * What this build did NOT understand about a report (#1138) — `undefined` when it understood all of
   * it, which is the overwhelmingly normal case and writes nothing.
   *
   * Loosening the contract root from `strictObject` to `object` traded a hard 400 (the host disappears
   * from the inventory) for silent stripping. Silence is the part that would be dangerous: a typo'd
   * key is indistinguishable from a field the server simply predates, and #1142 will give an ABSENT
   * key semantics of its own ("unchanged"). So the drop is recorded on the node, inside the existing
   * `specs` blob — no column, no migration, and it self-heals: the skew record is part of what the
   * write path compares (#1153), so one clean check-in differs from what is stored and clears it.
   *
   * The diff is against the PARSE, not against a root key list, so it covers the whole body: a nested
   * key a plain `z.object` stripped, and an enum value a `.catch()` coerced, are both skew and both
   * recorded. See `agentReportSkewPaths` for why a root-only recorder would have reported "everything
   * understood" for precisely the reports this exists to flag.
   *
   * It rides the EXISTING version handshake (ADR-0083 amendment / #907) rather than inventing a
   * surface: `agentVersion` already travels in every report and already lives in its own queryable
   * column, so comparing it to the running build lets the server say the useful thing — *this agent is
   * newer than me* — instead of the generic "I don't understand these fields". `isNewerVersion` is
   * fail-soft (a `dev`/unstamped build on either side ⇒ false), so an unstamped native run never
   * accuses anyone.
   */
  private agentSkew(
    report: AgentReport,
    rawBody: unknown,
  ): AgentReportSkew | undefined {
    if (rawBody === undefined) return undefined;
    // Bounded by the shared helper: the body is attacker-controlled, and this lands in a jsonb column.
    const { droppedPaths, coercedPaths } = agentReportSkewPaths(
      rawBody,
      report,
    );
    if (droppedPaths.length === 0 && coercedPaths.length === 0)
      return undefined;
    const serverVersion = appVersion();
    const agentAhead = isNewerVersion(report.agentVersion, serverVersion);
    const what = [
      droppedPaths.length ? `dropped [${droppedPaths.join(', ')}]` : '',
      coercedPaths.length ? `coerced [${coercedPaths.join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join('; ');
    this.logger.warn(
      `Agent report not fully understood — ${what}. ` +
        (agentAhead
          ? `Agent ${report.agentVersion} is NEWER than this server (${serverVersion}); upgrade the instance to consume it.`
          : `Agent ${report.agentVersion}, server ${serverVersion}. The host still reported.`),
    );
    return {
      ...(droppedPaths.length ? { droppedPaths } : {}),
      ...(coercedPaths.length ? { coercedPaths } : {}),
      agentAhead,
      serverVersion,
    };
  }

  /**
   * The curation-preserving "known host" update, shared by the normal KNOWN-key branch and the
   * P2002 race fallback in `ingestReport`. Refreshes inventory FACTS + liveness ONLY — it NEVER
   * writes `state`/`label`/`x`/`y`/`assetId`/`source`, so a human's curation survives every check-in.
   *
   * Fact promotion (#1081): the node's `ipAddress` is OVERWRITTEN with the report's primary IPv4 on
   * every check-in (a live fact) UNLESS a human curated it (`ipAddressSource === 'MANUAL'`), in which
   * case the human value is never clobbered; a report with no IPv4 leaves the existing value intact
   * (never nulled). When the node is asset-backed, the linked Asset's `specs` snapshot is refreshed
   * too, so the Asset inventory panel stays fresh — its human-owned columns (serial/name/model) are
   * left untouched.
   *
   * THE `specs` WRITE IS CONDITIONAL (#1153). Heartbeat is not inventory: `status`,
   * `lastReportedAt`, `agentVersion` and the policy columns are cheap scalars and are written on every
   * single check-in, because that is what a check-in IS. The jsonb blob is written only when the facts
   * inside it actually changed — see {@link planSpecsWrite}. At the default per-account rate limit a
   * leaked `infra:report` token could otherwise drive ~172,800 full rewrites a day of a multi-hundred-KB
   * TOAST value against a bounded set of rows, and #1147 raised the ceiling on how big each of those
   * rewrites may be from 100 KB to 8 MB.
   *
   * **What the skip does and does not bound.** It does not require the client to COOPERATE — the
   * comparison uses the server's own fingerprint of whatever arrived, so a pre-#1142 agent and an
   * attacker who sends no fingerprint at all are compared just the same, and a report that repeats
   * what is stored writes nothing however it was produced. It is not, however, a bound on a client
   * that varies its report: anything the comparison covers differing by one byte is a real change and
   * therefore writes, and that is deliberate — a comparison that ignored a difference would be losing
   * inventory. So a determined caller can still drive a rewrite per request, and #1142 made that
   * cheaper for them, not dearer: `softwareState: 'unchanged'` plus one varied host fact reaches the
   * same write with a few KB instead of a few hundred, and on the one branch that has to re-embed the
   * list it also costs a read of it. What bounds THAT is `InfraReportRateLimitGuard` (#1134), which
   * caps this route at `INFRA_REPORT_MAX_PER_WINDOW_DEFAULT` (120) requests per service account per
   * minute, and ultimately ADR-0074 §8's posture that `infra:report` is a low-value credential whose
   * blast radius is noise rather than damage. What the skip removes is the ~96 rewrites per host per
   * day a legitimate estate pays at the default 900-second cadence — the ~172,800 figure above is the
   * ABUSE ceiling, what the rate limit alone would still allow, not what an honest fleet drives — and,
   * for a leaked token that merely REPLAYS a report, that ceiling too. See the amendment in
   * ADR-0074 §2.
   */
  private async refreshKnownNode(args: {
    node: { id: string; assetId: string | null; ipAddressSource: string };
    blob: AgentReportSpecsBlob;
    software: SoftwareDirective;
    now: Date;
    agentVersion: string;
    primaryIpAddress: string | undefined;
    /** The #1140 policy columns. An EMPTY object is the pre-#1140 shape and writes nothing extra. */
    policyFields?: AgentPolicyWriteFields;
    /**
     * Did this report's collection run under the same #1140 policy generation as the stored facts
     * it is about to be diffed against? See {@link InfraService.samePolicyGeneration}. Required, so
     * a path added later cannot record a policy edit as a hardware or software event by omission.
     */
    samePolicyGeneration: boolean;
    /** Already-read stored blob, when the caller needed it too. Read here when it did not. */
    stored?: StoredNodeSpecs;
  }): Promise<AgentReportAck> {
    const { node, now, primaryIpAddress } = args;
    const stored = args.stored ?? (await this.storedNodeSpecs(node.id));
    const plan = await this.planSpecsWrite(
      node.id,
      args.blob,
      args.software,
      stored,
    );
    // WHAT MOVED (#1143), computed BEFORE the write — the stored package list this may have to read
    // back is about to be overwritten, so after the update there is nothing left to compare against.
    // The rows themselves are inserted after the update lands, so a failed write never leaves a
    // history row claiming a change that did not happen.
    const factChanges = await this.hostFactChanges(
      node.id,
      stored,
      plan,
      args.software,
      args.samePolicyGeneration,
    );
    const data: Prisma.InfraNodeUncheckedUpdateInput = {
      status: 'ONLINE',
      lastReportedAt: now,
      agentVersion: args.agentVersion,
      ...(args.policyFields ?? {}),
      ...(plan.write !== undefined ? { specs: plan.write } : {}),
    };
    // Overwrite the IP with the live fact — but only when the agent owns it (never a MANUAL edit) and
    // the report actually carries one (never clear a good IP on a partial report). CEO policy #1081.
    if (node.ipAddressSource !== 'MANUAL' && primaryIpAddress !== undefined) {
      data.ipAddress = primaryIpAddress;
    }
    const updated = await this.prisma.infraNode.update({
      where: { id: node.id },
      data,
      select: { id: true, state: true },
    });
    await this.recordFactChanges(node.id, factChanges);
    // Keep the linked Asset's specs snapshot fresh (agent-owned facts only). It is asked on EVERY
    // report even when the node's blob was skipped, and decides its own write the same way: an Asset
    // linked to a node whose facts have not changed since would otherwise never receive them.
    if (node.assetId) {
      await this.syncAssetSpecs(
        node.assetId,
        hostAssetFacts(plan),
        plan.softwareOwned
          ? ['host', 'reportedAt', 'software']
          : ['host', 'reportedAt'],
      );
    }
    void this.syncNodeToSearch(updated.id);
    return {
      nodeId: updated.id,
      state: updated.state,
      accepted: true,
      ...(plan.resend ? { softwareResend: true } : {}),
    };
  }

  /**
   * A node's stored inventory blob, MINUS the package list (#1141 + #1153) — the one read the report
   * hot path makes, serving the identity corroboration and the write planner alike.
   *
   * A raw sub-select rather than `select: { specs: true }` on purpose, and the shape of the projection
   * is the whole point. `specs` is the entire inventory — up to 5,000 packages on a real Linux box,
   * ~350 KB — and this runs once per host per report, forever. `specs - 'software'` strips the part
   * that dominates the column and leaves the few KB the server actually has to reason about, so the
   * package list stays in the database and is compared by its fingerprint instead of by its bytes.
   * Same lesson as #1135, one layer down.
   *
   * `hasSoftware` is the one bit the stripped blob cannot answer and both callers need: whether the
   * node holds a list at all. Parameterized, and addressed by a primary key resolved a moment earlier
   * through the soft-delete-scoped `findFirst`.
   *
   * Tolerant by construction: a missing row, a null `specs` and a hand-edited blob all read as "no
   * evidence" — which `isClonedMachineId` treats as "nothing to corroborate" and the write planner
   * treats as "nothing matches, write".
   *
   * WHICH IS WHY THE DELETE IS GUARDED. `jsonb - text` raises `cannot delete from scalar` when
   * `specs` holds a bare string or number rather than an object — a hand-edited row, or a restore
   * that put one there. Unguarded that is not a degradation but a 500 on the REPORT path, so one
   * edited row would stop a host checking in at all, and this contract's posture is degrade, never
   * reject. `jsonb_typeof` sends every non-object to NULL, which is the "no evidence" the callers
   * already handle. The other two operators need no guard: `->` and `jsonb_exists` are already total
   * on a scalar (verified against `postgres:18-alpine`, the image compose pins).
   */
  private async storedNodeSpecs(nodeId: string): Promise<StoredNodeSpecs> {
    const rows = await this.prisma.$queryRaw<
      Array<{ host: unknown; rest: unknown; hasSoftware: boolean | null }>
    >(
      Prisma.sql`SELECT "specs"->'host' AS host,
                        CASE WHEN jsonb_typeof("specs") = 'object'
                             THEN "specs" - 'software' END AS rest,
                        COALESCE(jsonb_exists("specs", 'software'), false) AS "hasSoftware"
                   FROM "infra_nodes" WHERE "id" = ${nodeId}`,
    );
    const row = rows[0];
    const rest = row?.rest;
    return {
      ...(typeof rest === 'object' && rest !== null && !Array.isArray(rest)
        ? { rest: rest as Record<string, unknown> }
        : {}),
      hasSoftware: row?.hasSoftware === true,
      identity: hostIdentityEvidence(row?.host),
    };
  }

  /**
   * Decide what this report does to a node's `specs` column — the crux of #1142 and #1153 together.
   *
   * Two independent questions, answered separately and then combined, because getting either wrong has
   * a different failure:
   *
   *  1. **Does the package list change?** `replace` compares the incoming fingerprint against the
   *     stored one; `clear` is satisfied only when the node holds no list; `preserve` is trivially
   *     satisfied, because it keeps the stored value literally. The fingerprint compared on `replace`
   *     is the SERVER's own, taken over the list that arrived, so a report that sent none is compared
   *     just the same; it is a `replace` against a STORED blob carrying no fingerprint that cannot be
   *     corroborated and therefore writes.
   *  2. **Does anything else change?** The rest of the blob is compared directly, with only the two
   *     per-report facts taken out — WHEN the collector ran (`reportedAt`) and HOW LONG it took
   *     (`diagnostics.durationMs`); one timestamp and one duration ({@link withoutVolatileReportFacts}).
   *
   * Only when BOTH say "no" is the write skipped. Everything else — a missing stored blob, a
   * fingerprint that does not corroborate, a value this build cannot compare — resolves by writing.
   * A wasted write costs some I/O; a missed one leaves the operator reading an inventory that has not
   * been true for weeks, with nothing on screen to say so.
   *
   * The ONE case that reads the stored package list back is `preserve` with the rest of the blob
   * changed: the new host facts have to be written, and writing them without re-embedding the list
   * would delete it. From a REAL agent that case is rare — when the software changed the agent sends
   * it, so this is "host facts moved while the package list did not" — and paying a single large read
   * for it is what buys the ~90% steady-state saving on every other report. A caller that does not
   * behave like a real agent can reach it on every request by claiming `unchanged` while varying a
   * host fact, which is the read half of the residual documented on
   * {@link InfraService.refreshKnownNode}; it is bounded by `InfraReportRateLimitGuard` (#1134), not
   * by this comparison, and the WRITE half is not new — before #1142 the same caller drove the same
   * write by sending a different package list, at several hundred KB a request instead of a few.
   */
  private async planSpecsWrite(
    nodeId: string,
    blob: AgentReportSpecsBlob,
    software: SoftwareDirective,
    stored: StoredNodeSpecs,
  ): Promise<SpecsWritePlan> {
    const storedHash =
      typeof stored.rest?.softwareHash === 'string'
        ? stored.rest.softwareHash
        : undefined;
    // The fingerprint the node will HOLD after this report. On `preserve` that is whatever it already
    // held — and nothing at all when it held no list, so a stored fingerprint can never outlive the
    // list it describes and make a later `unchanged` corroborate against a ghost.
    const hash =
      software.mode === 'replace'
        ? software.hash
        : software.mode === 'preserve' && stored.hasSoftware
          ? storedHash
          : undefined;
    const target: AgentReportSpecsBlob = {
      ...blob,
      ...(hash !== undefined ? { softwareHash: hash } : {}),
    };

    const restEqual =
      stored.rest !== undefined &&
      isDeepStrictEqual(
        withoutVolatileReportFacts(stored.rest),
        withoutVolatileReportFacts(target),
      );
    const softwareEqual =
      software.mode === 'preserve'
        ? true
        : software.mode === 'clear'
          ? !stored.hasSoftware
          : stored.hasSoftware && software.hash === storedHash;
    // The claim the server could not corroborate (#1142): the agent says its list is unchanged, and
    // this node either holds none, holds one fingerprinted differently, or the claim arrived with no
    // fingerprint at all. Never resolved by wiping — the stored list is kept and the agent is asked
    // for a full one on its next report. See {@link softwareResendWanted}.
    const resend = softwareResendWanted(software, {
      hasSoftware: stored.hasSoftware,
      ...(storedHash !== undefined ? { hash: storedHash } : {}),
    });

    if (restEqual && softwareEqual) {
      // NOTHING CHANGED. The stored blob is kept byte-for-byte, which is also why the effective
      // `reportedAt` is the STORED one: the facts on the node are the ones collected then, and saying
      // so is the honest reading. Liveness is `lastReportedAt`, a scalar column the caller still writes.
      return {
        effective: {
          ...target,
          ...(typeof stored.rest?.reportedAt === 'string'
            ? { reportedAt: stored.rest.reportedAt }
            : {}),
          ...(software.mode === 'replace'
            ? { software: software.software }
            : {}),
        },
        softwareOwned: software.mode !== 'preserve',
        resend,
      };
    }

    if (software.mode === 'replace') {
      const write: AgentReportSpecsBlob = {
        ...target,
        software: software.software,
      };
      return { write, effective: write, softwareOwned: true, resend };
    }
    if (software.mode === 'clear') {
      return { write: target, effective: target, softwareOwned: true, resend };
    }
    // PRESERVE, with something else in the blob changed. The list has to be read back and carried
    // over, because the blob is written wholesale and a write without it would delete it.
    if (!stored.hasSoftware) {
      return { write: target, effective: target, softwareOwned: false, resend };
    }
    const preserved = await this.storedSoftware(nodeId);
    if (preserved === undefined) {
      // The list vanished between the two reads (a concurrent report, a merge). Writing `target` here
      // would delete it; skipping the write leaves the node's host facts one report stale, which the
      // next report fixes. Between "lose the inventory" and "be late", late wins.
      this.logger.warn(
        `Could not re-read the stored software list for node ${nodeId} — its host facts stay as they were until the next report rather than being written without it.`,
      );
      // The node keeps what it held, so the Asset mirrors THAT and not this report. Syncing `target`
      // here would put facts on the Asset the node does not store — and the Asset is the surface an
      // operator reconciles from, so the two must never disagree about the same host.
      return {
        effective: heldSpecs(stored, target),
        softwareOwned: false,
        resend,
      };
    }
    const write: AgentReportSpecsBlob = { ...target, software: preserved };
    return { write, effective: write, softwareOwned: true, resend };
  }

  /**
   * The package list a node currently holds, read back on its own (#1142) — the deliberately expensive
   * path {@link planSpecsWrite} takes only when a report that omitted the list has other facts to
   * write. `undefined` when the node holds none, which the caller treats as "do not write a blob that
   * would delete it".
   */
  private async storedSoftware(
    nodeId: string,
  ): Promise<NonNullable<AgentReport['software']> | undefined> {
    const rows = await this.prisma.$queryRaw<Array<{ software: unknown }>>(
      Prisma.sql`SELECT "specs"->'software' AS software FROM "infra_nodes" WHERE "id" = ${nodeId}`,
    );
    const software = rows[0]?.software;
    return Array.isArray(software)
      ? (software as NonNullable<AgentReport['software']>)
      : undefined;
  }

  /**
   * WHAT MOVED on a host this report (#1143) — the rows the append-only fact history is about to
   * record, or an empty list when nothing worth recording did.
   *
   * IT BUILDS ON #1153's COMPARISON RATHER THAN MAKING A SECOND ONE. `planSpecsWrite` has already
   * decided whether the stored blob moved at all, and `plan.write === undefined` is that answer: a
   * report that changed nothing skips both the jsonb write and this, for zero extra cost on the ~96
   * reports a day per host that are the steady state.
   *
   * THE PACKAGE HALF IS THE EXPENSIVE ONE AND IS ENTERED ONLY WHEN IT HAS TO BE. Diffing packages
   * needs the stored list, which #1153 deliberately keeps OUT of the hot path — reading it back on
   * every report would undo the whole saving. So it is read only when the server's own fingerprint of
   * what arrived already disagrees with the one the node holds, i.e. only on the reports where the
   * package list genuinely moved: roughly twice a month per host, the same branch `apt upgrade`
   * produces. THIS METHOD adds no such read on `preserve` or `clear` — said precisely, because
   * `planSpecsWrite` still makes its OWN read on the `preserve`-with-changed-host-facts branch (it has
   * to re-embed the list it is about to overwrite), and the fact history neither triggers that read nor
   * takes any package rows off it. `clear` deliberately records NOTHING: `softwareState: 'disabled'`
   * is a policy event, and rendering it as three thousand removals would be a lie about the host.
   *
   * A node holding no list yet (`hasSoftware === false`) is the SEED case and is silent, which is what
   * keeps the first report after this ships from writing one row per installed package. The same rule
   * inside {@link diffHostFacts} covers every host fact.
   *
   * A POLICY GENERATION THAT MOVED SKIPS THE READ ENTIRELY. `samePolicyGeneration === false` means an
   * operator's #1140 policy changed between the stored observation and this one, so the shared diff
   * will discard every package row it could produce (`exclude.softwareNames`, `softwareSources` and
   * `softwareMax` each empty packages out of a report that are still installed). Paying a
   * several-hundred-KB read for rows that are about to be thrown away would be the one place this
   * feature made the report path measurably slower for nothing. That skip is an OPTIMISATION, not
   * the guard: the guard lives in {@link diffSoftwareFacts}, which is where a caller added later
   * inherits it.
   *
   * AND IT CANNOT FAIL THE CHECK-IN. Exactly one thing here can throw — the package read-back, a query
   * this feature ADDED to the report path — and it is the one thing inside the `try`; everything else
   * is a pure comparison over values already in hand. Without that catch, a fact history nobody asked
   * for could take a host off the map, which inverts the priority stated on {@link recordFactChanges}.
   * A throw degrades to "the host facts were recorded, the package half was not"; the report itself
   * lands exactly as it did before this change.
   */
  private async hostFactChanges(
    nodeId: string,
    stored: StoredNodeSpecs,
    plan: SpecsWritePlan,
    software: SoftwareDirective,
    samePolicyGeneration: boolean,
  ): Promise<InfraFactChangeDraft[]> {
    if (plan.write === undefined) return [];
    const changes = diffHostFacts(stored.rest?.host, plan.write.host, {
      samePolicyGeneration,
    });
    const storedHash =
      typeof stored.rest?.softwareHash === 'string'
        ? stored.rest.softwareHash
        : undefined;
    if (
      software.mode !== 'replace' ||
      !stored.hasSoftware ||
      software.hash === storedHash ||
      !samePolicyGeneration ||
      changes.length >= INFRA_FACT_CHANGES_MAX_PER_REPORT
    ) {
      return changes;
    }
    try {
      const previous = await this.storedSoftware(nodeId);
      return [
        ...changes,
        ...diffSoftwareFacts(
          previous,
          software.software,
          INFRA_FACT_CHANGES_MAX_PER_REPORT - changes.length,
          { samePolicyGeneration },
        ),
      ];
    } catch (err) {
      // The host facts that were already diffed are still good; only the package half is lost.
      this.logger.warn(
        `Could not read node ${nodeId}'s stored package list to diff it — its package changes are NOT recorded for this report, and the report was still accepted. ${err instanceof Error ? err.message : String(err)}`,
      );
      return changes;
    }
  }

  /**
   * Append what moved to the node's fact history (#1143) — the ONE write path for
   * `InfraNodeFactChange`, shared by the host refresh and the container reconciliation.
   *
   * NOTHING HERE MAY FAIL A CHECK-IN. A history row is strictly less valuable than the report that
   * carries it: a host whose report 500s vanishes from the CMDB, shows OFFLINE on the map and nudges
   * the bell (ADR-0074 §4), while a history row that was not written costs one line in a timeline. So
   * every failure — a constraint, a DB hiccup, a node deleted between the update and this insert —
   * degrades to a warning and the report still acks — the same posture, for the same reason, as
   * {@link resolvePolicy}.
   *
   * The two caps are applied here rather than at the callers so neither can be forgotten by a path
   * added later: {@link INFRA_FACT_CHANGES_MAX_PER_REPORT} bounds one report, and the COUNT bounds one
   * node across {@link INFRA_FACT_CHANGES_WINDOW_MS}. The COUNT runs only when there is something to
   * write, so a quiet estate never pays for it.
   */
  private async recordFactChanges(
    nodeId: string,
    changes: InfraFactChangeDraft[],
  ): Promise<void> {
    if (changes.length === 0) return;
    try {
      const recent = await this.prisma.infraNodeFactChange.count({
        where: {
          nodeId,
          createdAt: {
            gte: new Date(Date.now() - INFRA_FACT_CHANGES_WINDOW_MS),
          },
        },
      });
      const room = INFRA_FACT_CHANGES_MAX_PER_NODE_WINDOW - recent;
      if (room <= 0) {
        this.logger.warn(
          `Node ${nodeId} has already recorded ${INFRA_FACT_CHANGES_MAX_PER_NODE_WINDOW} fact changes this hour — ${changes.length} more are DROPPED. Already-recorded history is untouched, and recording resumes in the next window.`,
        );
        return;
      }
      const rows = changes.slice(
        0,
        Math.min(room, INFRA_FACT_CHANGES_MAX_PER_REPORT),
      );
      await this.prisma.infraNodeFactChange.createMany({
        data: rows.map((change) => ({
          nodeId,
          kind: change.kind,
          fact: change.fact.slice(0, INFRA_FACT_CHANGE_FACT_MAX),
          previousValue: change.previousValue ?? null,
          currentValue: change.currentValue ?? null,
        })),
      });
    } catch (err) {
      this.logger.warn(
        `Could not record ${changes.length} fact change(s) for node ${nodeId} — the report was still accepted. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * A page of a node's recorded fact history (#1143), newest first — what the Changes tab reads.
   *
   * Keyset pagination on the autoincrement `id` rather than an offset: the table is append-only, so
   * ids only ever grow and the pages walk strictly DOWNWARD, so a row already recorded when paging
   * started can never be repeated or stepped over, however many reports land in between — including a
   * concurrent report whose lower id commits after a higher one, which an offset would have shifted.
   * `nextCursor` is null on the last page.
   *
   * The node is checked for EXISTENCE first — soft-delete-scoped by the Prisma extension, so a node
   * that is off the map answers 404 rather than serving its history. Deliberately NOT {@link getNode}:
   * that is an unprojected `findFirst` and would pull the node's whole `specs` jsonb — including the
   * installed-package list #1153 built {@link storedNodeSpecs} to keep off hot paths — on every page
   * of a tab the operator scrolls, to read one boolean off it. `select: { id: true }` is the whole
   * requirement (#1135 is the same defect class, found on the list endpoint).
   */
  async listNodeFactChanges(
    nodeId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<InfraNodeFactChangeList> {
    const node = await this.prisma.infraNode.findFirst({
      where: { id: nodeId },
      select: { id: true },
    });
    if (!node) {
      throw new NotFoundException(`Infra node ${nodeId} not found`);
    }
    const limit = Math.min(
      Math.max(options.limit ?? INFRA_FACT_CHANGE_PAGE_SIZE, 1),
      INFRA_FACT_CHANGE_PAGE_SIZE_MAX,
    );
    const rows = await this.prisma.infraNodeFactChange.findMany({
      where: {
        nodeId,
        ...(options.cursor !== undefined ? { id: { lt: options.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      // One extra row is the "is there another page?" probe — cheaper than a second COUNT query.
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      items: items.map((row) => ({
        id: row.id,
        nodeId: row.nodeId,
        kind: row.kind,
        fact: row.fact,
        previousValue: row.previousValue,
        currentValue: row.currentValue,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * When this node's collision was FIRST detected (#1141), or `undefined` if it carries no marker.
   *
   * The marker is re-stamped on every report (see {@link ingestCollidingHost}), and a marker whose
   * timestamp moved with it would only ever say "still colliding" — the operator also needs "and it
   * has been true since the 10th". So the re-stamp reads the first detection back and keeps it.
   *
   * Same posture as {@link storedNodeSpecs}: a `->>` sub-select rather than reading the whole
   * inventory blob back on a path that runs once per host every 15 minutes. Postgres returns SQL NULL
   * (⇒ `null` here) for a missing node, a null `specs` and an absent key alike, so every degenerate
   * case reads as "no marker yet" and the caller stamps `now`.
   */
  private async storedConflictDetectedAt(
    nodeId: string,
  ): Promise<string | undefined> {
    const rows = await this.prisma.$queryRaw<
      Array<{ detectedAt: string | null }>
    >(
      Prisma.sql`SELECT "specs"->'identityConflict'->>'detectedAt' AS "detectedAt" FROM "infra_nodes" WHERE "id" = ${nodeId}`,
    );
    const detectedAt = rows[0]?.detectedAt;
    return typeof detectedAt === 'string' && detectedAt.length > 0
      ? detectedAt
      : undefined;
  }

  /**
   * A SECOND physical host is reporting the `externalId` an existing node already owns (#1141) — the
   * cloned-VM-template case, which without this quietly collapsed a whole estate into one row.
   *
   * Three rules, in order of how much they matter:
   *
   *  1. **The report is still accepted.** Degrade and inform, never reject — the same posture the rest
   *     of the contract takes. A host that 400s vanishes from the CMDB, which is the failure this
   *     change exists to prevent, not a remedy for it.
   *  2. **Nothing existing is touched.** The node that owns the key is not written to at all: no
   *     re-label, no re-key, no soft-delete. The colliding host gets a NEW `state=PENDING` proposal,
   *     which is exactly what an unrecognised host has always got, and the human gate does the rest.
   *  3. **One nudge, naming the remedy.** Emitted only on the branch that CREATES the second node, and
   *     deduped on `(peer node, discriminator)`, so a clone checking in every 15 minutes nudges once —
   *     the same one-per-event discipline the staleness sweeper's `infra.agent_offline` follows.
   *  4. **The marker is DURABLE.** `specs.identityConflict` is re-stamped on every report for as long
   *     as the collision lasts, so a marker written only at creation would be gone the first time
   *     anything else in the blob moved — leaving the operator holding a notification that points at
   *     a node showing no evidence of why. `detectedAt` keeps the FIRST detection across re-stamps.
   *     It still SELF-HEALS: once the clone is given a real machine-id it takes the ordinary
   *     unknown-key path, nothing re-stamps, and the next blob write drops the marker. Since #1153
   *     the re-stamp usually writes NOTHING — the marker is part of what the write path compares, so
   *     an unchanged collision matches and a resolved one differs, which is exactly rule 4's promise.
   *
   * The new node cannot reuse the reported `externalId`: the partial-unique
   * `infra_nodes_reporting_source_external_id_key` physically forbids two live rows sharing one. It
   * therefore gets a DETERMINISTIC derived key (`<externalId>#<serial-or-MAC>`) so the same clone lands
   * on the same node on every report — and so the operator can see, in the row itself, why there are
   * two. See {@link disambiguateExternalId}.
   */
  private async ingestCollidingHost(
    peer: { id: string; label: string },
    stored: HostIdentityEvidence,
    incoming: HostIdentityEvidence,
    report: AgentReport,
    blob: AgentReportSpecsBlob,
    software: SoftwareDirective,
    now: Date,
    primaryIpAddress: string | undefined,
    principal?: Principal,
    // Resolved against the PEER's override, not the clone's own node: the clone's node may not exist
    // yet, and once it does its own override applies from the next report. A colliding host is a
    // configuration edge case of a configuration edge case; getting it merely correct-next-tick is
    // the same one-tick propagation the whole feature is built on (#1140/#1141).
    policy?: AgentPolicy,
  ): Promise<AgentReportAck> {
    const discriminator = identityDiscriminator(incoming);
    if (discriminator === undefined) {
      // Unreachable: the rule that got us here requires a serial AND a MAC on both sides. Falling
      // back to the ordinary refresh rather than throwing keeps the machine-facing path total.
      return this.finishAck(
        await this.refreshKnownNode({
          node: { id: peer.id, assetId: null, ipAddressSource: 'AGENT' },
          blob,
          software,
          now,
          agentVersion: report.agentVersion,
          primaryIpAddress,
          // This branch did not read the peer's stored revision (it writes no policy columns
          // either), so it cannot show that the two observations shared a generation. Unproven
          // reads as "the policy may have moved": the cost is a skipped diff on a branch documented
          // as unreachable, against recording a policy edit as a hardware event.
          samePolicyGeneration: false,
        }),
        policy,
      );
    }
    const externalId = disambiguateExternalId(report.externalId, discriminator);
    // Everything the marker says except WHEN — identical whether it is being stamped or re-stamped.
    const conflictFacts = {
      reportedExternalId: report.externalId,
      peerNodeId: peer.id,
      peerLabel: peer.label,
      discriminator,
    };
    /** Refresh the clone's own node, carrying the collision marker with it (rule 4 above). */
    const refreshWithMarker = async (node: {
      id: string;
      assetId: string | null;
      ipAddressSource: string;
      policyRevision?: number | null;
    }): Promise<AgentReportAck> => {
      const conflict: AgentReportIdentityConflict = {
        ...conflictFacts,
        detectedAt:
          (await this.storedConflictDetectedAt(node.id)) ?? now.toISOString(),
      };
      return this.finishAck(
        await this.refreshKnownNode({
          node,
          blob: { ...blob, identityConflict: conflict },
          software,
          now,
          agentVersion: report.agentVersion,
          primaryIpAddress,
          policyFields: this.policyWriteFields(
            report,
            node.policyRevision,
            policy,
            now,
          ),
          samePolicyGeneration: this.samePolicyGeneration(
            report,
            node.policyRevision,
          ),
        }),
        policy,
      );
    };

    // Does this clone already have a node of its own? (Its second and every later report.)
    const own = await this.prisma.infraNode.findFirst({
      where: { reportingSource: report.reportingSource, externalId },
      select: {
        id: true,
        assetId: true,
        ipAddressSource: true,
        policyRevision: true,
      },
    });
    if (own) return refreshWithMarker(own);

    // A new row, so it is charged to the same enrollment budget as any other newly-enrolled host
    // (#1134) — a clone storm is exactly the unbounded row growth that limit exists to bound.
    this.enrollment.assertWithinBudget(principal);

    const conflict: AgentReportIdentityConflict = {
      ...conflictFacts,
      detectedAt: now.toISOString(),
    };
    let created: { id: string; state: AgentReportAck['state'] };
    try {
      created = await this.prisma.infraNode.create({
        data: {
          kind: 'PHYSICAL_HOST',
          label: report.host.hostname,
          status: 'ONLINE',
          source: 'AGENT',
          state: 'PENDING',
          reportingSource: report.reportingSource,
          externalId,
          lastReportedAt: now,
          agentVersion: report.agentVersion,
          ...(primaryIpAddress !== undefined
            ? { ipAddress: primaryIpAddress, ipAddressSource: 'AGENT' as const }
            : {}),
          ...this.policyWriteFields(report, null, policy, now),
          // Same rule as the ordinary create branch (#1142): a row that does not exist yet holds no
          // package list, so this one carries whatever the report actually sent and nothing more.
          specs: {
            ...blob,
            ...(software.mode === 'replace'
              ? { software: software.software, softwareHash: software.hash }
              : {}),
            identityConflict: conflict,
          },
        },
        select: { id: true, state: true },
      });
    } catch (err) {
      // The SAME concurrent-report race the main ingest path has handled since #1012, and it bites
      // harder here: a newly-detected clone reporting from two processes at once would 500 at exactly
      // the moment the operator most needs a clear signal. The derived key is deterministic, so the
      // racing report inserted the very row we wanted — re-resolve it and refresh (ack, never 409).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.infraNode.findFirst({
          where: { reportingSource: report.reportingSource, externalId },
          select: {
            id: true,
            assetId: true,
            ipAddressSource: true,
            policyRevision: true,
          },
        });
        // No loop and no nudge: after P2002 the row exists, and the report that WON it emitted the
        // notification already (the dedupe key is identical, so a second emit would be dropped
        // anyway). If the row somehow isn't there — soft-deleted in the same instant — rethrow the
        // original error rather than invent one.
        if (raced) return refreshWithMarker(raced);
      }
      throw err;
    }

    // Corroborating detail only — the two hosts agreeing on a name is the template signature, and it
    // never gated the detection (see `isClonedMachineId`).
    const sharesHostname =
      incoming.hostname.length > 0 &&
      stored.hostname.toLowerCase() === incoming.hostname.toLowerCase();

    // The command AND the name of the colliding fact, for the platform that is reporting. Both are
    // Linux-shaped words on a Linux host and Windows-shaped words on a Windows one; #1144 made the
    // second case reachable. See {@link identityConflictRemedy}.
    const remedy = identityConflictRemedy(osFamily(report.host));

    this.logger.warn(
      `Two hosts are reporting externalId ${report.externalId}: "${peer.label}" (${peer.id}) and ` +
        `"${report.host.hostname}" (${created.id}). Almost always a cloned VM template or golden ` +
        `image carrying a baked ${remedy.identity} — nothing was merged; the second host landed as ` +
        `a separate PENDING proposal.`,
    );
    // Best-effort, exactly like the staleness sweeper's nudge: a failed emit must never fail a report.
    await this.notifications.emit({
      type: 'infra.identity_conflict',
      dedupeKey: `infra.identity_conflict:${peer.id}:${discriminator}`,
      severity: 'warning',
      title: `Two hosts share one ${remedy.identity}: ${report.host.hostname} and ${peer.label}`,
      // The remedy leads, deliberately: the bell renders a summary as ONE truncated line (full text
      // on hover), so whatever an operator can act on has to be in the first few words. "Identity
      // conflict detected" as an opener would leave them exactly as stuck as the silence did.
      summary:
        `${remedy.lead} — "${report.host.hostname}" and ` +
        `"${peer.label}" report the same ${remedy.identity} but a different hardware serial AND ` +
        `different network cards, so they are two servers, not one. ` +
        // Hostname is NOT part of the rule (a golden image bakes it in alongside the identity), but
        // it is the detail that makes the message make sense: without this the operator reads what
        // looks like one name twice and assumes the alert is confused.
        (sharesHostname
          ? `They also report the same hostname ("${incoming.hostname}") — the golden-image signature. `
          : '') +
        `Almost always a cloned VM template or golden image. Nothing was merged: the new host ` +
        `is waiting in the review tray.`,
      // No entityType — the bell deep-links this type to the topology map, like agent_offline.
      metadata: {
        nodeId: created.id,
        hostname: report.host.hostname,
        peerNodeId: peer.id,
        peerLabel: peer.label,
        discriminator,
      },
    });

    void this.syncNodeToSearch(created.id);
    return this.finishAck(
      {
        nodeId: created.id,
        state: created.state,
        accepted: true,
        // A brand-new row holds no list to keep, so an `unchanged` claim is one this server cannot
        // honour — with a fingerprint or without one. Ask for the whole thing rather than leave the
        // clone's inventory permanently empty (#1142). See {@link softwareResendWanted}.
        ...(softwareResendWanted(software, { hasSoftware: false })
          ? { softwareResend: true }
          : {}),
      },
      policy,
    );
  }

  /**
   * Reconcile the containers a host reported into CONTAINER child nodes joined to it by an active
   * `RUNS_ON` edge (#1139) — the first thing the agent produces that the topology GRAPH can traverse.
   *
   * Until this existed the agent produced not one edge: install it on a Proxmox host and its guests
   * and you got unrelated boxes floating on a canvas, with the blast-radius traversal ADR-0070 §7 was
   * built for reduced to a feature the operator had to hand-draw before using. `PLAUSIBLE_EDGE_TARGETS`
   * has anticipated `CONTAINER -> PHYSICAL_HOST` since day one; this is what finally opens it.
   *
   * ABSENT AND EMPTY ARE DIFFERENT ANSWERS. An absent `containers` key means the collector never
   * probed — an older agent, a non-Linux collector, an unreadable socket — so nothing is touched and a
   * host keeps every child it already has. `[]` means the probe RAN and found none, which retires
   * them. Conflating the two would let a downgraded agent silently wipe a host's whole topology.
   *
   * NEVER FAILS THE REPORT. Everything here runs after the host row is durable, so a failure degrades
   * to a stale container topology and a warning — the same degrade-never-reject posture the contract
   * takes. Losing the container list for one tick costs a field; losing the report makes the HOST
   * vanish from the inventory, which is the failure class ADR-0074 §2's amendment exists to prevent.
   */
  private async reconcileContainers(
    ack: AgentReportAck,
    report: AgentReport,
    now: Date,
    // The children ride the SAME report, collected by the same agent under the same policy, so the
    // host's answer is theirs (#1143). Threaded rather than recomputed per child: a child's own
    // `policyRevision` column is written from this very report, so reading it back would compare a
    // value against itself and always answer "same" — the guard would exist and never fire.
    samePolicyGeneration: boolean,
    principal?: Principal,
    // The host's resolved policy (#1140): it rides out on the ack, and its staleness threshold is
    // stamped on each CHILD so a daily-cadence host's containers are not swept dark hourly.
    policy?: AgentPolicy,
  ): Promise<AgentReportAck> {
    const containers = report.host.containers;
    if (containers === undefined) return this.finishAck(ack, policy);
    try {
      await this.applyContainerTopology(
        ack.nodeId,
        containers,
        report,
        now,
        samePolicyGeneration,
        principal,
        policy,
      );
    } catch (err) {
      this.logger.warn(
        `Container topology for ${report.host.hostname} could not be reconciled — the host itself still reported. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.finishAck(ack, policy);
  }

  /**
   * The container reconcile proper (#1139), split out so {@link reconcileContainers} owns exactly one
   * thing: the promise that none of this can fail the host's report.
   *
   * Children are reconciled on the SAME `(reportingSource, externalId)` unique index the host path
   * uses — the child's `externalId` is `containerExternalId(host, name)` — so this needs no column, no
   * index and no migration. The key is the container's NAME scoped to its host, deliberately and
   * permanently: a runtime container id is regenerated by every `docker compose up --force-recreate`,
   * so an id-keyed node would mint a fresh PENDING proposal on every deploy and orphan the last one.
   *
   * A child lands PENDING, like its host. ADR-0074 §1 ratified the review tray as the containment for
   * everything a machine proposes, and a container node is not a lesser proposal than a host — it is
   * a row in the official inventory the moment it is confirmed. // The tray ERGONOMICS of 40 children
   * arriving as 40 individual items is a real and separate problem (grouping the tray by reporting
   * host, a confirm-all-children action); it is a UI question, and answering it by quietly weakening
   * the gate here would be the wrong place to answer it.
   */
  private async applyContainerTopology(
    hostNodeId: string,
    containers: readonly AgentContainer[],
    report: AgentReport,
    now: Date,
    samePolicyGeneration: boolean,
    principal?: Principal,
    policy?: AgentPolicy,
  ): Promise<void> {
    // A child's liveness follows its HOST's cadence, so it is judged against the host's served
    // staleness threshold (#1140). Without this, moving a host to a daily cadence would leave its
    // containers on the global env cutoff and the §4 sweeper would report a false outage for every
    // one of them within the hour.
    //
    // Gated on the host's ECHO for exactly the reason `policyWriteFields` is: a child follows its
    // host, and a host whose agent predates the policy channel is not running a served threshold.
    // Containers arrived in contract v2 (#1139), one release before the policy channel, so an agent
    // that reports children while echoing no revision is a real shape rather than a hypothetical.
    const childPolicyFields =
      policy !== undefined && report.policyRevision !== undefined
        ? { policyStaleAfterSeconds: policy.staleAfterSeconds }
        : {};
    // Every child this reporter already has for THIS host. Scoped by the prefix, because container
    // names are only unique within one runtime: two hosts both running `redis` are two containers,
    // and a host-less key would fuse them into one node whose RUNS_ON edge flapped between hosts.
    //
    // `specs` and `assetId` ride along (#1153/#1157). A child's blob is a handful of fields, not a
    // package list, so reading it back costs nothing and lets the same skip-when-unchanged rule the
    // host path follows apply here — which is what keeps a container's stored `reportedAt` meaning the
    // same thing on both. `assetId` is what a confirmed container's Asset sync needs; the findMany is
    // soft-delete-scoped, so a DISCARDED child never appears here and can never have facts
    // resurrected onto its Asset.
    const known: {
      id: string;
      externalId: string | null;
      specs: Prisma.JsonValue;
      assetId: string | null;
    }[] =
      (await this.prisma.infraNode.findMany({
        where: {
          reportingSource: report.reportingSource,
          externalId: {
            startsWith: containerExternalIdPrefix(report.externalId),
          },
        },
        select: { id: true, externalId: true, specs: true, assetId: true },
      })) ?? [];
    const knownByExternalId = new Map(
      known.flatMap((n) => (n.externalId ? [[n.externalId, n] as const] : [])),
    );

    // WHAT THE AGENT REPORTED — computed from the WHOLE list before anything is written, and
    // deliberately independent of what this pass manages to enrol. The retire sweep below reads it,
    // and it must answer "did the agent still list this container?", never "did the server get to
    // it?". Built inside the loop it stopped at the enrollment budget, so every container after the
    // refusal looked ABSENT and its still-running node was marked OFFLINE — a false outage invented
    // by a throttle. The budget is per service account and shared fleet-wide, and children spend it
    // too, so exhausting it mid-list is a normal rollout event.
    const reported = new Set(
      containers.map((c) => containerExternalId(report.externalId, c.name)),
    );
    const childIds: string[] = [];
    let budgetSpent = false;
    for (const container of containers) {
      const externalId = containerExternalId(report.externalId, container.name);
      // The child's whole inventory blob — what this report WOULD store. Whether it is stored is
      // decided below: since #1153 the write is conditional on the facts actually having moved, on
      // the host path and here alike. When it is written it replaces the column wholesale, which is
      // why it has to be complete rather than a patch.
      // No `host` key, because a container is not a host: the web `container` projection
      // (`getAgentContainerFacts`) reads this shape and renders it as a Container panel — on the node
      // drill-in and, once confirmed with asset tracking on, on the Asset detail page. Keep the
      // `container` key: without it both surfaces fall back to the raw custom-fields grid, which
      // JSON.stringifies the blob.
      const specs: ContainerSpecsBlob = {
        container,
        reportedAt: report.reportedAt,
      };
      // A LIVENESS fact the agent owns, exactly like the host node's `status` on check-in.
      const status = containerNodeStatus(container.state);

      const child = knownByExternalId.get(externalId);
      if (child !== undefined) {
        // Facts + liveness only. `kind`/`label`/`state`/position stay the human's, on the same rule
        // `refreshKnownNode` applies to hosts — and, since #1153, on the same write rule too: the
        // `specs` column is touched only when the container's facts actually changed, while the
        // heartbeat columns are written on every report because that is what a check-in is.
        const storedSpecs = (child.specs ?? {}) as Record<string, unknown>;
        const unchanged = isDeepStrictEqual(
          withoutVolatileReportFacts(storedSpecs),
          withoutVolatileReportFacts(specs),
        );
        // What the child HOLDS after this report — the stored collection time when the write was
        // skipped, so the node and its Asset never disagree about when these facts were gathered.
        const effective: ContainerSpecsBlob = unchanged
          ? {
              container: specs.container,
              ...(typeof storedSpecs.reportedAt === 'string'
                ? { reportedAt: storedSpecs.reportedAt }
                : { reportedAt: specs.reportedAt }),
            }
          : specs;
        // WHAT MOVED on this container (#1143), read off the SAME comparison the write rule above
        // already made — computed before the update, for the same reason the host path computes it
        // there: `storedSpecs` is about to be replaced. A container whose image digest moved under an
        // unchanged `:latest` tag is the deploy nobody remembers doing, and it is exactly the kind of
        // change this table exists for. Runtime `state` is deliberately NOT recorded — it is liveness,
        // it already drives this node's `status`, and a nightly restart would write two rows a day
        // forever. See {@link diffContainerFacts}.
        const childChanges = unchanged
          ? []
          : diffContainerFacts(storedSpecs.container, specs.container, {
              samePolicyGeneration,
            });
        await this.prisma.infraNode.update({
          where: { id: child.id },
          data: {
            ...(unchanged
              ? {}
              : { specs: specs as unknown as Prisma.InputJsonValue }),
            status,
            lastReportedAt: now,
            agentVersion: report.agentVersion,
            ...childPolicyFields,
          },
        });
        await this.recordFactChanges(child.id, childChanges);
        // #1157: the host path has synced its linked Asset since #1081 and this one never did, so a
        // container confirmed with `trackAsAsset` froze its Asset panel at the instant it was
        // confirmed — image tag, digest, runtime state and published ports all drifting silently while
        // the node panel stayed fresh. Same discipline as the host: a direct write (no SPECS_CHANGED
        // event per report), human-owned columns untouched, a soft-deleted asset skipped, only the
        // agent-owned keys replaced — and no write at all when nothing moved.
        if (child.assetId) {
          await this.syncAssetSpecs(child.assetId, { ...effective }, [
            'container',
            'reportedAt',
          ]);
        }
        childIds.push(child.id);
        void this.syncNodeToSearch(child.id);
        continue;
      }

      // A child row costs the same enrollment slot a host does (#1134) — one report enrolling N+1
      // rows must be as bounded as one enrolling one. A spent budget REFUSES instead of throwing:
      // the host is already durable, and a 429 here would read to the agent as "nothing landed".
      //
      // It SKIPS, it does not BREAK. Breaking abandoned the rest of the list, so every already-known
      // container listed after the refusal stopped having its `lastReportedAt` advanced and its
      // RUNS_ON edge healed — the §4 staleness sweeper then retired running containers a few hours
      // later, which is the same false outage the retire sweep above no longer produces immediately.
      // Once refused, stop asking: a spent window stays spent for this report, and re-charging per
      // remaining container would only add noise.
      if (budgetSpent || !this.enrollment.tryCharge(principal)) {
        budgetSpent = true;
        continue;
      }
      const created = await this.prisma.infraNode.create({
        data: {
          kind: 'CONTAINER',
          label: container.name,
          status,
          source: 'AGENT',
          state: 'PENDING',
          reportingSource: report.reportingSource,
          externalId,
          lastReportedAt: now,
          agentVersion: report.agentVersion,
          ...childPolicyFields,
          specs: specs as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      childIds.push(created.id);
      void this.syncNodeToSearch(created.id);
      // The child half of #1145. A container child is offered to the matcher under its CONTAINER
      // NAME, with no IP of its own — the host owns the address, and pretending the child reported
      // one would let a subnet rule confirm containers on the strength of their host's wire.
      await this.autoConfirmProposal(
        created.id,
        'PENDING',
        {
          hostname: container.name,
          ipAddress: null,
          kind: 'CONTAINER',
          isContainerChild: true,
        },
        // The CHILD's own key — a container the operator discarded is as durable a decision as a
        // discarded host, and its host having been confirmed says nothing about it.
        { reportingSource: report.reportingSource, externalId },
      );
    }
    if (budgetSpent) {
      // Says exactly what happened, no more: the containers that already had nodes were refreshed,
      // and the ones that did not have no node YET. An earlier draft of this line claimed "nothing
      // was lost", which was both unfalsifiable and — while the sweep read a truncated list — false.
      this.logger.warn(
        `Enrollment budget spent while reconciling ${report.host.hostname}'s containers — containers with no node yet are NOT enrolled until a later report. Known children were still refreshed and none was retired.`,
      );
    }

    await this.openMissingRunsOnEdges(childIds, hostNodeId, now);

    // A container the reporter no longer lists goes OFFLINE. NOT soft-deleted: deleting is the
    // human's call (the existing Discard), and an auto-delete would also churn — the dedup index is
    // over LIVE rows, so a flapping container would accumulate a dead row per flap instead of
    // reviving the one node the operator curated. Its `lastReportedAt` simply stops advancing, so the
    // §4 staleness sweeper independently agrees.
    const vanished = known
      .filter((n) => n.externalId !== null && !reported.has(n.externalId))
      .map((n) => n.id);
    if (vanished.length) {
      await this.prisma.infraNode.updateMany({
        where: { id: { in: vanished } },
        data: { status: 'OFFLINE' },
      });
      for (const id of vanished) void this.syncNodeToSearch(id);
    }
  }

  /**
   * Open the `RUNS_ON` edge for every child that has none (#1139) — SELF-HEALING rather than
   * create-once, so a child whose edge was lost to a transient failure is not left floating
   * unparented on the canvas forever.
   *
   * An edge to a LIVE target is left completely alone, which is what keeps this compatible with the
   * one-active-RUNS_ON-per-source partial unique index (ADR-0070 §3) and with a human who
   * deliberately re-parented a node. // A human who CLOSES the edge does get it re-opened on the next
   * report: "this container executes on this host" is a reported fact, not a layout choice, and the
   * same rule already applies to the node's IP.
   *
   * An edge to a DISCARDED (soft-deleted) target is NOT left alone — it is closed and re-opened here.
   * Discarding a node soft-deletes the row and leaves its edges open, so a re-discovered host gets a
   * brand-new node (the dedup lookup is live-scoped) while its children stay wired to the dead one:
   * the child floats off the map and the new host shows no children. Only the soft-deleted case is
   * healed, so a live re-parent stays the human's. Prisma's soft-delete extension filters only the
   * TOP-LEVEL operation, so the nested `target` read genuinely returns the discarded row rather than
   * `null` — which is exactly what makes the discarded case detectable here.
   */
  private async openMissingRunsOnEdges(
    childIds: string[],
    hostNodeId: string,
    now: Date,
  ): Promise<void> {
    if (childIds.length === 0) return;
    const active: {
      id: string;
      sourceId: string;
      target: { deletedAt: Date | null } | null;
    }[] =
      (await this.prisma.infraEdge.findMany({
        where: { sourceId: { in: childIds }, kind: 'RUNS_ON', endedAt: null },
        select: {
          id: true,
          sourceId: true,
          target: { select: { deletedAt: true } },
        },
      })) ?? [];
    const parented = new Set<string>();
    const toDiscardedHost: string[] = [];
    for (const edge of active) {
      // A missing `target` row can only mean the node is gone entirely (the FK cascades), which is
      // the same orphan case: close the edge and re-parent.
      if (edge.target && edge.target.deletedAt === null) {
        parented.add(edge.sourceId);
      } else {
        toDiscardedHost.push(edge.id);
      }
    }
    if (toDiscardedHost.length) {
      // Close BEFORE opening: the partial unique index allows exactly one active RUNS_ON per source.
      await this.prisma.infraEdge.updateMany({
        where: { id: { in: toDiscardedHost } },
        data: { endedAt: now },
      });
    }
    for (const sourceId of childIds) {
      if (parented.has(sourceId)) continue;
      try {
        await this.prisma.infraEdge.create({
          data: { sourceId, targetId: hostNodeId, kind: 'RUNS_ON' },
        });
      } catch (err) {
        // A concurrent report from the same host opened it first — the invariant HELD, so this is
        // the success case arriving by another route, not a failure worth propagating.
        if (
          !(
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          )
        ) {
          throw err;
        }
      }
    }
  }

  /**
   * Apply an operator-authored auto-confirm rule to a node that was JUST proposed (ADR-0074 §1
   * amendment, #1145). Returns the state the node is now in, for the ack.
   *
   * Called from exactly two places, both of them a `create` this method's caller performed in the
   * same request: the unknown-host branch of {@link ingestReport} and the new-child branch of
   * {@link applyContainerTopology}. It is deliberately NOT called from the known-host refresh (a
   * proposal already in the tray must never confirm behind the operator who is looking at it — that
   * is the non-retroactivity promise, and it is kept by where this is called, not by a flag) and NOT
   * from {@link ingestCollidingHost} (a cloned machine-id exists to be SEEN as two rows; a rule
   * matching the hostname both clones share would confirm the very duplicate #1141 exists to surface).
   *
   * The confirm goes through {@link confirmNode} — the same method a human's tray click calls, with
   * the RULE AUTHOR's principal. That is what keeps §8's containment argument true of an automatic
   * confirm: the Asset it mints is attributed to the operator who wrote the rule, exactly as a
   * hand-confirmed one is attributed to the operator who clicked. A rule whose author has since been
   * deleted still fires, with no principal — stated rather than hidden, and visible on the rule.
   *
   * **A DISCARD outranks every rule.** Discarding soft-deletes the row and keeps its reporting key,
   * so the next report from that host creates a brand-new node under the same key — and a matching
   * rule would confirm it, and mint another Asset, on the very next check-in. That would make a
   * discard undoable by a machine: the operator says "not this one", and the estate says it again
   * every fifteen minutes. So a key that a human has ALREADY discarded is enrolled, as it always was,
   * and left PENDING for that human to decide a second time. The bulk-discard copy promises exactly
   * this, and it is kept here rather than in the copy.
   *
   * NEVER FAILS THE REPORT, on the same reasoning as the container reconcile: the node row is already
   * durable, so a failure here degrades to a node that stays PENDING — which is where it was going
   * anyway, and which the operator can act on — while throwing would make the host vanish from the
   * inventory.
   */
  private async autoConfirmProposal(
    nodeId: string,
    currentState: InfraNodeState,
    candidate: InfraAutoConfirmCandidate,
    identity: { reportingSource: string; externalId: string },
  ): Promise<InfraNodeState> {
    try {
      if (await this.wasDiscarded(identity)) {
        this.logger.log(
          `"${candidate.hostname}" (${nodeId}) reports under a key a human discarded — it stays PENDING for review rather than being auto-confirmed.`,
        );
        return currentState;
      }
      const resolved = await this.autoConfirm.resolve(candidate);
      if (!resolved) return currentState;
      await this.confirmNode(
        nodeId,
        {
          trackAsAsset: resolved.trackAsAsset,
          ...(resolved.confirmAsKind !== null
            ? { kind: resolved.confirmAsKind }
            : {}),
        },
        resolved.author,
      );
      await this.autoConfirm.recordMatch(resolved.ruleId);
      this.logger.log(
        `Auto-confirmed "${candidate.hostname}" (${nodeId}) on rule "${resolved.ruleName}" (${resolved.ruleId}).`,
      );
      return 'CONFIRMED';
    } catch (err) {
      this.logger.warn(
        `Auto-confirm rules could not be applied to ${candidate.hostname} (${nodeId}) — it stays PENDING in the review tray. ${err instanceof Error ? err.message : String(err)}`,
      );
      return currentState;
    }
  }

  /**
   * Has a human already discarded this reporting key? Reads past the soft-delete filter with the
   * ADR-0032 `includeSoftDeleted` escape hatch, because the discarded row is exactly what the normal
   * read hides.
   *
   * A MERGED source is not a discard and cannot be confused with one: `mergeInto` clears the archived
   * row's `reportingSource`/`externalId` (the pair moves to the adopting node), so only a genuine
   * discard leaves a soft-deleted row still holding the key.
   */
  private async wasDiscarded(identity: {
    reportingSource: string;
    externalId: string;
  }): Promise<boolean> {
    const discarded = await this.prisma.infraNode.findFirst({
      where: {
        reportingSource: identity.reportingSource,
        externalId: identity.externalId,
        deletedAt: { not: null },
      },
      select: { id: true },
      includeSoftDeleted: true,
    } as Prisma.InfraNodeFindFirstArgs);
    return discarded !== null;
  }

  /**
   * Refresh a linked Asset's `specs` inventory snapshot from a fresh report (#1081, #1157) — so the
   * Asset inventory panel mirrors its node on every check-in.
   *
   * Merges over the existing specs: `ownedKeys` are cleared and replaced by `facts`, while every
   * human-added key (custom fields, the `_infraAutoCreated` marker, a serial fallback) is preserved.
   * Writes `specs` DIRECTLY (not via AssetsService.update) on purpose: this is an agent fact refresh,
   * so it must NOT emit a SPECS_CHANGED history event on every report (that would flood the asset's
   * audit trail) and must NEVER touch the Asset's human-owned serial/name/modelId. A soft-deleted
   * asset is skipped — the soft-delete extension scopes `findFirst`, so a detached/archived asset
   * simply resolves to null.
   *
   * The keys are a PARAMETER because two shapes reach this method (#1157): a host node's
   * `host`/`software`/`reportedAt`, and a CONTAINER child's `container`/`reportedAt`. A single
   * hard-coded set would have one of them deleting the other's facts on every report.
   *
   * The {@link NODE_ONLY_SPECS_KEYS} are deliberately NOT carried over, and are stripped if an older
   * build left one behind.
   *
   * IT DECIDES ITS OWN WRITE (#1153). If the merge produces exactly what is already stored, nothing is
   * written — otherwise skipping the node's jsonb rewrite would simply move the write amplification
   * onto the Asset table. The comparison is over the WHOLE merged object, so a human key an older
   * build left behind, or an agent fact that moved by one byte, still writes.
   *
   * WITH ONE EXCEPTION, AND IT IS THE ONE THE NODE ALREADY MAKES. A re-ordered package list is not a
   * changed one: `softwareFingerprint` is order-independent because `dpkg-query` and `rpm -qa` promise
   * no order, so the node's own skip ignores it. `isDeepStrictEqual` does not, so the node's write was
   * skipped while the Asset's fired on every single report from a host whose package manager re-sorted
   * its output — the exact amplification this method exists to prevent, surviving on the other table.
   * {@link sameSoftwareList} settles that one key by the same fingerprint the node uses; everything
   * else, the list's CONTENTS included, still compares by value.
   */
  private async syncAssetSpecs(
    assetId: string,
    facts: Record<string, unknown>,
    ownedKeys: readonly string[],
  ): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { specs: true },
    });
    if (!asset) return; // soft-deleted / detached — nothing to refresh.
    const existing = (asset.specs ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const key of ownedKeys) delete merged[key];
    for (const key of NODE_ONLY_SPECS_KEYS) delete merged[key];
    Object.assign(merged, facts);
    // The same list in a different order is the same list — keep the stored ordering so the
    // comparison below agrees with the node's own (see the JSDoc). A no-op when the orders match.
    if (sameSoftwareList(merged.software, existing.software)) {
      merged.software = existing.software;
    }
    if (isDeepStrictEqual(merged, existing)) return;
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { specs: merged as Prisma.InputJsonValue },
    });
  }

  /**
   * Confirm a PENDING agent-reported node from the review tray (ADR-0074 §3) — the HUMAN gate that
   * promotes a discovered host into the official inventory. 404 if the node is missing/soft-deleted.
   *
   *   - state flips `PENDING → CONFIRMED`; optional `kind`/`label` overrides let the operator
   *     re-classify/rename (the agent lands every host as `PHYSICAL_HOST` with the hostname as label).
   *   - `trackAsAsset` (default true) + no existing link → mint a backing Asset via the SAME reused
   *     `AssetsService.create` path `createNode` uses, carrying the agent's host facts (`specs`) over so
   *     the Asset is populated, and stamping the auto-created provenance marker so a later detach
   *     soft-deletes it (ADR-0070 §5). `trackAsAsset: false` leaves the node graph-only.
   *
   * IDEMPOTENT: confirming a node that is ALREADY CONFIRMED is a no-op (no Asset minted, no re-flip) —
   * it just returns the current detail. Re-confirming is a safe retry, not a 409 (the tray's confirm
   * button can be double-clicked). // ponytail: there is NO reject/discard endpoint — discarding a
   * PENDING proposal is just `DELETE /infra/nodes/:id` (the existing soft-delete), so this builds none.
   */
  async confirmNode(id: string, dto: ConfirmInfraNode, principal?: Principal) {
    const node = await this.getNode(id);
    if (node.state !== 'PENDING') {
      // Already curated (or never pending) — idempotent no-op, return the current enriched detail.
      return this.getNodeDetail(id, principal);
    }

    const trackAsAsset = dto.trackAsAsset ?? true;
    const label = dto.label ?? node.label;

    // Mint the backing Asset only when tracking AND the node isn't already linked. Reuse the exact
    // createNode path: carry the agent's host facts over + stamp the auto-created provenance marker.
    let assetId = node.assetId ?? undefined;
    if (trackAsAsset && !node.assetId) {
      const hostSpecs = (node.specs ?? {}) as Record<string, unknown>;
      // Promote the discovered hardware serial to the canonical `Asset.serial` (#1081) — only a
      // sanitized real serial (dmidecode junk placeholders dropped). The raw value always survives in
      // `specs.host.hardware.serial`, so on a unique-serial collision we retry WITHOUT the serial
      // rather than fail the confirm. `modelId` is deliberately left null (no AssetModel auto-create).
      const host = (hostSpecs.host ?? {}) as AgentReportHost;
      const serial = sanitizeSerial(host);
      const assetSpecs: Record<string, unknown> = {
        ...hostSpecs,
        [INFRA_AUTO_ASSET_MARKER]: true,
      };
      // Same rule as the repeat-report refresh (#1138/#1142): the report diagnostics and the software
      // fingerprint stay on the node. This is the path that mints the Asset, so without the strip the
      // very first thing a confirmed host's inventory snapshot carries is a diagnostic about a report
      // the server half-understood — and unlike the node's blob, an Asset's specs are MERGED, so it
      // would never clear itself.
      for (const key of NODE_ONLY_SPECS_KEYS) delete assetSpecs[key];
      let created: { id: string };
      try {
        created = await this.assets.create(
          {
            name: label,
            status: 'UNKNOWN',
            ...(serial !== undefined ? { serial } : {}),
            specs: assetSpecs,
          },
          principal,
        );
      } catch (err) {
        // A discovered serial that collides with an existing LIVE asset's serial (P2002 on
        // `assets_serial_active_key`) must NOT fail the confirm — retry without it (the serial stays
        // in specs). Any other error propagates unchanged.
        if (serial !== undefined && isSerialUniqueCollision(err)) {
          created = await this.assets.create(
            { name: label, status: 'UNKNOWN', specs: assetSpecs },
            principal,
          );
        } else {
          throw err;
        }
      }
      assetId = created.id;
    }

    const updated = await this.prisma.infraNode.update({
      where: { id },
      data: {
        state: 'CONFIRMED',
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
      },
    });
    // Fire-and-forget search re-sync: state/kind/label/asset link may have changed (ADR-0035).
    void this.syncNodeToSearch(updated.id);
    return this.getNodeDetail(id, principal);
  }

  /**
   * Confirm MANY PENDING proposals in one request (ADR-0074 §1 amendment, #1145) — the tray's answer
   * to a Docker host that enrols itself plus one CONTAINER child per running container.
   *
   * It DELEGATES, per item, to {@link confirmNode}: the same method the single tray click calls, with
   * the same optional `trackAsAsset`/`kind`/`label` overrides. Bulk confirm is therefore incapable of
   * having semantics of its own — no second Asset-minting path, no second serial promotion, no second
   * idempotency rule to keep in step. What is genuinely new is only the batching.
   *
   * Overrides are PER ITEM, not per batch, because `label` is not a batch concept and because the
   * confirmation a host and its containers want differs: the tray's default is `trackAsAsset` ON for a
   * host and OFF for a child (`defaultTrackAsAsset`), and a per-batch flag could not express both.
   *
   * PER-ITEM OUTCOMES, not one all-or-nothing verdict — the degrade-never-reject posture the report
   * path takes, applied to a human action. One node failing (a serial that collides with an existing
   * Asset, a node another operator discarded a second earlier) must not discard the thirty-nine that
   * succeeded and leave the operator unable to tell which. An already-CONFIRMED node reads `skipped`
   * rather than failing, mirroring the single confirm's idempotency; a vanished one reads `notFound`.
   *
   * SEQUENTIAL, not `Promise.all`: each item can mint an Asset and re-index, so a 200-item batch fired
   * at once is a thundering herd against the same tables — and a failure that is attributable to one
   * item is worth more here than the milliseconds concurrency would buy.
   */
  async bulkConfirmNodes(
    dto: BulkConfirmInfraNodes,
    principal?: Principal,
  ): Promise<InfraBulkResponse> {
    // One read for the whole batch: which of these ids are live, and what state/label they carry. The
    // soft-delete extension scopes it, so a discarded node simply does not come back.
    const rows = await this.prisma.infraNode.findMany({
      where: { id: { in: dto.items.map((item) => item.id) } },
      select: { id: true, label: true, state: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const results: InfraBulkResult[] = [];
    for (const item of dto.items) {
      const row = byId.get(item.id);
      if (!row) {
        results.push({
          id: item.id,
          outcome: 'notFound',
          label: null,
          message: null,
        });
        continue;
      }
      if (row.state !== 'PENDING') {
        results.push({
          id: item.id,
          outcome: 'skipped',
          label: row.label,
          message: null,
        });
        continue;
      }
      const { id, ...overrides } = item;
      try {
        await this.confirmNode(id, overrides, principal);
        results.push({
          id,
          outcome: 'applied',
          label: row.label,
          message: null,
        });
      } catch (err) {
        results.push({
          id,
          outcome: 'failed',
          label: row.label,
          // The message the single action would have returned, verbatim — the tray shows it beside
          // the row's name, which is the difference between "3 failed" and something actionable.
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.tallyBulk(results);
  }

  /**
   * Discard MANY PENDING proposals in one request (#1145). Discard is still the EXISTING soft delete
   * (ADR-0074 §3: there is no reject endpoint) — a discarded proposal is restorable and its history is
   * kept — so this is `removeNode`'s semantics applied to a set, not a new lifecycle.
   *
   * One `updateMany` over the ids that are actually live, rather than a loop: unlike confirm there is
   * no per-node work to attribute, so the whole batch is one statement and one pass of search removals
   * (fire-and-forget, ADR-0035). An id that is already gone reads `notFound` and never widens the
   * write, so a stale tray tab can never resurrect-then-delete anything.
   */
  async bulkDiscardNodes(
    dto: BulkDiscardInfraNodes,
  ): Promise<InfraBulkResponse> {
    const rows = await this.prisma.infraNode.findMany({
      where: { id: { in: dto.ids } },
      select: { id: true, label: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    if (rows.length > 0) {
      await this.prisma.infraNode.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { deletedAt: new Date() },
      });
      // Off the map ⇒ out of the search index, exactly like the single delete.
      for (const row of rows) this.search.remove('infra', row.id);
    }

    return this.tallyBulk(
      dto.ids.map((id) => {
        const row = byId.get(id);
        return row
          ? { id, outcome: 'applied' as const, label: row.label, message: null }
          : { id, outcome: 'notFound' as const, label: null, message: null };
      }),
    );
  }

  /** Count the per-item outcomes so the caller's toast never re-tallies them (one definition). */
  private tallyBulk(results: InfraBulkResult[]): InfraBulkResponse {
    return {
      applied: results.filter((r) => r.outcome === 'applied').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      notFound: results.filter((r) => r.outcome === 'notFound').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      results,
    };
  }

  /**
   * A page-less list of nodes, newest first, filtered; soft-deleted nodes excluded by the extension.
   * Each row carries the Servers-list payoff (ADR-0070 §6, issue #750): the linked Asset's inventory
   * `assetName` and its active `owners` — joined in ONE query (a single relation join, NOT an
   * N+1 per-row detail fetch), then flattened to the lean `InfraNodeListItem` wire shape. Mirrors the
   * `getNodeDetail` resolution: `label` always wins for display, `assetName` is the secondary name.
   *
   * PROJECTION, NOT `include` (issue #1135). An explicit `select` of exactly the columns the wire
   * shape promises, so the ONE column it leaves out — `specs` — never crosses the wire. On an
   * agent-reported host (ADR-0074) `specs` is the entire inventory blob, installed-software list and
   * all (~1500 entries on a real Linux box); a bare `include` returns every scalar, so a 40-node
   * estate turned each poll of this endpoint into megabytes. And this endpoint IS polled: the PENDING
   * review tray every 40s (`INFRA_LIVE_POLL_MS`) and the create-agent wizard every 5s while the
   * operator waits for their new host to check in. Nothing in a list renders `specs` — the drill-in
   * (`getNodeDetail`) keeps the full blob for the reported-facts panel, which is its only reader.
   * Keep this `select` in step with `InfraNodeListItemSchema`: a field added there but not here
   * silently disappears from the list (the spec asserts the two agree).
   *
   * CRITICAL — the soft-delete extension only filters the TOP-LEVEL operation (`infraNode.findMany`),
   * NOT nested relation reads (verified against the Prisma query-extension docs). And a `where` filter
   * is NOT allowed on a to-ONE relation include (`asset` is to-one) — Prisma only filters to-MANY
   * relation lists inside `include`/`select`. So we select the asset's `deletedAt` alongside `name`
   * and gate the name in app code: a soft-deleted (detached/archived) Asset never leaks its name
   * (`assetName: null`), exactly as `getNodeDetail`'s soft-delete-filtered `findFirst` already honours.
   * Owners mirror `resolveOwners` exactly: ACTIVE assignments only (`releasedAt: null`), newest first,
   * with the owner user inlined — a departed (soft-deleted) USER still surfaces with its `deletedAt`
   * set, so the UI renders the same "left the company" affordance (history kept, ADR-0019).
   */
  async listNodes(filters: InfraNodeFilters = {}) {
    const rows = await this.prisma.infraNode.findMany({
      where: {
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.state ? { state: filters.state } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kind: true,
        label: true,
        status: true,
        assetId: true,
        ipAddress: true,
        ipAddressSource: true,
        shortcuts: true, // bounded by INFRA_SHORTCUTS_MAX — unlike `specs`, safe to carry per row
        x: true,
        y: true,
        source: true,
        state: true,
        reportingSource: true,
        externalId: true,
        lastReportedAt: true,
        agentVersion: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        // NOTE: `specs` is deliberately absent (#1135) — see the doc comment.
        asset: {
          // `deletedAt` is selected (not filterable on a to-one relation) so the flatten can gate the
          // name — a soft-deleted asset must NOT leak its name through the list.
          select: {
            name: true,
            deletedAt: true,
            assignments: {
              where: { releasedAt: null },
              orderBy: { assignedAt: 'desc' },
              select: {
                id: true,
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    deletedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return rows.map(({ asset, ...node }) => ({
      ...node,
      // Gate the name on the asset being live (the to-one relation can't be where-filtered).
      assetName: asset && asset.deletedAt === null ? asset.name : null,
      owners: (asset?.assignments ?? []).map((a) => ({
        assignmentId: a.id,
        userId: a.user.id,
        firstName: a.user.firstName,
        lastName: a.user.lastName,
        email: a.user.email,
        deletedAt: a.user.deletedAt,
      })),
    }));
  }

  /** A single live node by id (the lean row); 404 if missing or soft-deleted. */
  async getNode(id: string) {
    const node = await this.prisma.infraNode.findFirst({ where: { id } });
    if (!node) {
      throw new NotFoundException(`Infra node ${id} not found`);
    }
    return node;
  }

  /**
   * The enriched drill-in (ADR-0070 §6) — the asset-backed payoff. Returns the node PLUS its owners
   * (active AssetAssignment via the linked Asset), KB links (PUBLISHED, folder-scoped to the caller),
   * secret HANDLES (never values — INV-10), and its children (nodes hosted on it via active inverse
   * RUNS_ON). `assetName` is the secondary inventory name; `label` always wins for display.
   */
  async getNodeDetail(id: string, principal?: Principal) {
    const node = await this.getNode(id);

    // Children: nodes pointing AT this node with an ACTIVE RUNS_ON (inverse — "what runs on me").
    // `source: { deletedAt: null }` is required: InfraEdge is not soft-deletable (it closes via
    // `endedAt`, so the soft-delete extension never touches it), and a node's edges are NOT closed when
    // the node is soft-deleted — so a deleted child would resurface through its still-active edge. The
    // extension only scopes the top-level model, never a nested to-one `source` projection (#1067).
    const childEdges = await this.prisma.infraEdge.findMany({
      where: {
        targetId: id,
        kind: 'RUNS_ON',
        endedAt: null,
        source: { deletedAt: null },
      },
      select: {
        source: { select: { id: true, label: true, kind: true, status: true } },
      },
    });
    const children = childEdges.map((e) => e.source);

    // Asset-backed payoff (only when linked): owners + inventory name + KB links. Graph-only → empties.
    let assetName: string | null = null;
    let owners: Awaited<ReturnType<typeof this.resolveOwners>> = [];
    let articleLinks: Awaited<ReturnType<typeof this.resolveArticleLinks>> = [];
    if (node.assetId) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: node.assetId },
        select: { name: true },
      });
      assetName = asset?.name ?? null;
      owners = await this.resolveOwners(node.assetId);
      articleLinks = await this.resolveArticleLinks(node.assetId, principal);
    }

    // Node→secret linkage (ADR-0073, #801): resolve this node's soft handle-refs to LIVE secret
    // METADATA only (handle/label/vaultId), never values (INV-10). Dangling refs (the secret was
    // soft-deleted or its editable handle renamed away) are dropped during resolution.
    const secretRefs = await this.resolveNodeSecretRefs(id);

    // Soft duplicate-IP conflict signal (ADR-0090, #847): other LIVE nodes carrying the SAME
    // ipAddress. DISPLAY-ONLY — it drives a badge on the drill-in and NEVER blocks a create/update
    // (no DB uniqueness). Empty when the node has no IP or no peer shares it.
    const ipConflict = await this.resolveIpConflict(node.id, node.ipAddress);

    return {
      ...node,
      assetName,
      owners,
      articleLinks,
      secretRefs,
      children,
      ipConflict,
    };
  }

  /**
   * The SOFT duplicate-IP conflict signal for the drill-in (ADR-0090, #847): other LIVE nodes sharing
   * this node's exact `ipAddress`, as lean `{ id, label, kind, status }` peers. Display-only — the
   * caller surfaces it as a badge; it NEVER gates a mutation and there is NO DB uniqueness constraint.
   * Empty for a node with no IP; self is excluded, and archived nodes are excluded by the soft-delete
   * extension (this is a top-level `findMany`, which the extension scopes). Exact-string match on
   * purpose (ponytail): two nodes with the same IPv6 typed in different forms won't pair — an accepted
   * best-effort limit for a display hint, not a network-truth engine.
   */
  private async resolveIpConflict(
    id: string,
    ipAddress: string | null,
  ): Promise<InfraNodeChild[]> {
    if (!ipAddress) return [];
    return this.prisma.infraNode.findMany({
      where: { ipAddress, id: { not: id } },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, kind: true, status: true },
    });
  }

  /**
   * Load a node's secret soft-links and resolve them to LIVE secret METADATA (ADR-0073, #801) — the
   * `secretRefs` the drill-in + attach/detach return. METADATA ONLY (handle/label/vaultId), NEVER a
   * value/envelope (INV-10); a ref whose secret is no longer live (soft-deleted / handle renamed away)
   * is dropped by the resolver. Stable-sorted (label, then handle) by the resolver.
   */
  private async resolveNodeSecretRefs(
    nodeId: string,
  ): Promise<InfraSecretRef[]> {
    const links = await this.prisma.infraNodeSecretRef.findMany({
      where: { nodeId },
      select: { handle: true, vaultId: true },
    });
    if (links.length === 0) return [];
    return this.secrets.resolveHandlesMetadata(links);
  }

  /**
   * Attach a secret HANDLE reference to a node (ADR-0073, #801). The node must be live (else 404). The
   * caller must be a LIVE member of `dto.vaultId` AND `dto.handle` must resolve to a live secret in
   * that vault — enforced by {@link SecretManagerService.assertHandleAttachable} (403 non-member, 404
   * no live handle; membership FIRST so a non-member can't probe handle existence). The join is
   * UPSERTED on the `(nodeId, vaultId, handle)` unique, so re-attaching is an idempotent no-op (NOT a
   * 409). Returns the node's UPDATED resolved `secretRefs` (handles only — INV-10).
   */
  async attachSecret(
    nodeId: string,
    dto: AttachInfraSecret,
    principal?: Principal,
  ): Promise<InfraSecretRef[]> {
    await this.getNode(nodeId);
    // Layer-2 authz: live vault membership + a live handle in that vault (metadata-only; no envelope).
    await this.secrets.assertHandleAttachable(
      principal,
      dto.vaultId,
      dto.handle,
    );
    await this.prisma.infraNodeSecretRef.upsert({
      where: {
        nodeId_vaultId_handle: {
          nodeId,
          vaultId: dto.vaultId,
          handle: dto.handle,
        },
      },
      create: { nodeId, vaultId: dto.vaultId, handle: dto.handle },
      update: {},
    });
    return this.resolveNodeSecretRefs(nodeId);
  }

  /**
   * Detach a secret HANDLE reference from a node (ADR-0073, #801). The node must be live (else 404).
   * This is a TOPOLOGY edit — the route permission (`infra:manage`) is the only gate; NO secret
   * membership is required (no value is touched). HARD-deletes the matching join row and is idempotent
   * (deleting a missing ref is a no-op via `deleteMany`, never P2025). Returns the UPDATED resolved
   * `secretRefs` (handles only — INV-10).
   */
  async detachSecret(
    nodeId: string,
    dto: AttachInfraSecret,
  ): Promise<InfraSecretRef[]> {
    await this.getNode(nodeId);
    await this.prisma.infraNodeSecretRef.deleteMany({
      where: { nodeId, vaultId: dto.vaultId, handle: dto.handle },
    });
    return this.resolveNodeSecretRefs(nodeId);
  }

  /** Active owners of an asset (multi-owner), each a lean summary; via the active AssetAssignment join. */
  private async resolveOwners(assetId: string) {
    const rows = await this.assignments.findAll({
      assetId,
      activeOnly: true,
      includeUser: true,
    });
    return rows.map((a) => {
      const user = (a as typeof a & { user: AssignmentUser }).user;
      return {
        assignmentId: a.id,
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        deletedAt: user.deletedAt,
      };
    });
  }

  /** PUBLISHED KB articles linked to the asset, folder-scoped to the caller (reuses ArticlesService). */
  private async resolveArticleLinks(assetId: string, principal?: Principal) {
    // The reverse list is paginated; the drill-in shows the first page (a node rarely has many links).
    // parsePageQuery({}) yields the default window (limit 50, offset 0, deleted 'active').
    const page = await this.articles.findArticlesForAsset(
      assetId,
      {},
      parsePageQuery({}),
      principal,
    );
    return page.items;
  }

  /**
   * Partial update of a node. `assetId: null` DETACHES the asset (ADR-0070 §5): if the linked asset
   * was AUTO-CREATED by a node (carries the provenance marker), it is SOFT-DELETED (it must not linger
   * in inventory owned-by-nobody); if it PRE-EXISTED, the node only nulls `assetId` and the asset is
   * left intact. Any other field is a plain update. 404 if the node is missing/soft-deleted.
   *
   * A NON-NULL `assetId` splits in two (ADR-0070 §5 note, #1117), and only the node's CURRENT link
   * tells them apart — which is why neither case can be decided by `UpdateInfraNodeSchema`:
   *
   *  - **First-attach** (the node carries NO asset) — ALLOWED. There is no previous link to drop, so
   *    it orphans nothing. What it was missing is the liveness check `createNode` performs:
   *    `assets.assertExists`, whose `findFirst` the soft-delete extension scopes to live rows. The FK
   *    only requires the row to EXIST and a DISCARDED asset's row does, so without it a soft-deleted
   *    asset went straight into the column. (A wholly non-existent id was at least stopped — by the
   *    FK, as a generic `Invalid reference` 400 rather than the clean 404 `assertExists` gives.)
   *  - **Re-point** (the node ALREADY carries an asset) — refused with a 400. It dropped the previous
   *    link WITHOUT running the §5 detach below, leaving an auto-created backing Asset live in
   *    inventory owned by nobody. Refusing leaves delete semantics exactly as §5 wrote them: the
   *    alternative, auto-soft-deleting the asset a re-point orphaned, would delete a row a human may
   *    have curated. The remedy is the two-step the operator can actually take — `assetId: null` to
   *    detach (running §5 on the outgoing asset), then a second patch carrying the new id.
   */
  async updateNode(id: string, data: UpdateInfraNode, principal?: Principal) {
    const node = await this.getNode(id);

    if (data.assetId != null) {
      // Order matters: a re-point is refused for WHAT it is, before the incoming id is even resolved,
      // so the caller gets the rule rather than a 404 about an asset that was never the problem.
      if (node.assetId) {
        throw new BadRequestException(INFRA_NODE_ASSET_REPOINT_ERROR);
      }
      await this.assets.assertExists(data.assetId);
    }

    // Detach branch: assetId explicitly set to null while a link exists → run the §5 detach semantics.
    if (data.assetId === null && node.assetId) {
      await this.detachAsset(node.assetId, principal);
    }

    const { specs, shortcuts, ...rest } = data;
    const updated = await this.prisma.infraNode.update({
      where: { id },
      data: {
        ...rest,
        // A human edit to the IP marks it MANUAL (#1081) so the next agent report never clobbers the
        // curated value — derived server-side (never client-settable) so `source` stays a trusted
        // provenance marker. Clearing the IP is a human choice too, so it also stamps MANUAL.
        ...(data.ipAddress !== undefined
          ? { ipAddressSource: 'MANUAL' as const }
          : {}),
        ...(specs !== undefined
          ? {
              specs:
                specs === null
                  ? Prisma.DbNull
                  : (specs as Prisma.InputJsonValue),
            }
          : {}),
        ...(shortcuts !== undefined
          ? {
              shortcuts:
                shortcuts === null
                  ? Prisma.DbNull
                  : (shortcuts as Prisma.InputJsonValue),
            }
          : {}),
      },
    });
    // Fire-and-forget search re-sync: label/kind/status/ipAddress (and the asset link, on detach) may
    // have changed (ADR-0035). Un-awaited, never throws, no-op when Meili is disabled.
    void this.syncNodeToSearch(updated.id);
    return updated;
  }

  /**
   * Detach an asset from a node (ADR-0070 §5). Soft-delete it IFF it was auto-created by a node (the
   * provenance marker in `specs`); otherwise leave it intact (the node update nulls `assetId`). Reuses
   * AssetsService.remove so the soft-delete emits its DELETED history event + drops from search.
   */
  private async detachAsset(assetId: string, principal?: Principal) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { specs: true },
    });
    if (!asset) return; // already gone — nothing to detach (the node update still nulls assetId).
    const specs = (asset.specs ?? {}) as Record<string, unknown>;
    if (specs[INFRA_AUTO_ASSET_MARKER] === true) {
      await this.assets.remove(assetId, principal);
    }
  }

  /** PATCH a node's canvas position (x/y). Cheap + debounce-friendly (ADR-0070 MVP). 404 if missing. */
  async updatePosition(id: string, x: number, y: number) {
    await this.getNode(id);
    return this.prisma.infraNode.update({ where: { id }, data: { x, y } });
  }

  /** Soft-delete a node (off the map, history kept). 404 if missing or already soft-deleted. */
  async removeNode(id: string) {
    await this.getNode(id);
    const removed = await this.prisma.infraNode.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Drop from the search index (a soft-deleted node is off the map). Fire-and-forget, never throws,
    // no-op when Meili is disabled (ADR-0035). Mirrors AssetsService.remove.
    this.search.remove('infra', id);
    return removed;
  }

  /** Restore a soft-deleted node. 404 if it never existed; idempotent if already live. */
  async restoreNode(id: string) {
    const node = await this.prisma.infraNode.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.InfraNodeFindFirstArgs);
    if (!node) {
      throw new NotFoundException(`Infra node ${id} not found`);
    }
    if (node.deletedAt === null) return node; // already live — no-op.
    const restored = await this.prisma.infraNode.update({
      where: { id },
      data: { deletedAt: null },
    });
    // Back on the map → re-index it. Fire-and-forget, never throws, no-op when disabled (ADR-0035).
    void this.syncNodeToSearch(restored.id);
    return restored;
  }

  // ── Identity reconciliation: the HUMAN half (ADR-0074 §3 amendment, #1141) ───────────────────────

  /**
   * Re-key a node: move the agent identity of `sourceId` onto `targetNodeId` and archive the source.
   *
   * This is the one operator action that closes BOTH identity failures the report path can only warn
   * about:
   *
   *  - **Re-image.** Reinstalling the OS on the same box mints a new identity key (a fresh
   *    `/etc/machine-id` on Linux, a fresh `MachineGuid` on Windows), so the host
   *    arrives as a brand-new PENDING proposal while the node the operator curated — with its asset
   *    link, owners, position, edges and KB links — drifts OFFLINE forever. Merging the proposal into
   *    it transplants the new key and the curated node simply keeps living.
   *  - **Clone collapse.** The same action adopts a separated clone into whichever node really is it.
   *
   * IDENTITY MOVES; CURATION DOES NOT. `label`, `state`, `kind`, `x`/`y`, `assetId` and the target's
   * edges are never written — the agent owns facts, the human owns curation, and a merge is not a
   * licence to break that. `specs` is MERGED the way {@link syncAssetSpecs} merges an Asset's: the
   * agent-owned keys come from the source, every other key on the target survives.
   *
   * ONE TRANSACTION, in this order: archive the source (which is what frees its dedup key — the
   * partial-unique index covers live rows only), then write that key onto the target. Reversed, the
   * second write would collide with the first.
   *
   * THE ARCHIVED SOURCE IS THE AUDIT TRAIL. There is no `InfraNodeHistory` table (ADR-0074 §8 states
   * that plainly), so rather than pretend otherwise this stamps the merge onto the row it soft-deletes:
   * who merged it, into what, when, the key it carried, and — when the target had one — the key that
   * key REPLACED. That row can never be overwritten by another report — a soft-deleted node no longer
   * matches the dedup lookup — which is exactly why the record goes there and not onto the target,
   * whose `specs` the next report that changes anything rewrites wholesale.
   *
   * THE ARCHIVED SOURCE IS ALSO RESTORABLE. Its `reportingSource`/`externalId` are CLEARED as it is
   * archived, because the same pair is being written onto the target and the partial-unique dedup
   * index would refuse to bring the row back (a soft delete that cannot be undone is not the soft
   * delete [[0006-soft-delete-and-auditing]] promises). Restoring it returns the row and its curation
   * — never the reporting key, which now belongs to the node it was merged into.
   *
   * A MERGE CAN DESTROY A LIVE REPORTING KEY. The re-image case always does: the target still carries
   * the key it had before the reinstall. That key is not saved anywhere on the live graph — the target
   * has exactly one — so it is recorded on the archived row (`replacedTargetKey`) and logged. The
   * consequence is worth knowing: if a host is still reporting under the replaced key, it now matches
   * no live node and comes back as a fresh PENDING proposal.
   *
   * The source's linked Asset (if any) is deliberately left alone, matching `removeNode`: archiving a
   * node has never detached or soft-deleted its Asset, and a merge is not the place to invent that.
   */
  async mergeNodeInto(
    sourceId: string,
    targetNodeId: string,
    principal?: Principal,
  ) {
    if (sourceId === targetNodeId) {
      throw new BadRequestException(
        'A node cannot be merged into itself — pick the other node it is a duplicate of.',
      );
    }
    const source = await this.getNode(sourceId); // 404 if missing/archived
    const target = await this.getNode(targetNodeId);
    if (!source.reportingSource || !source.externalId) {
      throw new BadRequestException(
        'This node carries no agent identity to transplant — merging only moves a reporting key from an agent-discovered node onto another node.',
      );
    }

    const now = new Date();
    const { userId } = this.actor.resolveActor(principal);
    const sourceSpecs = (source.specs ?? {}) as Record<string, unknown>;
    const targetSpecs = (target.specs ?? {}) as Record<string, unknown>;
    // The agent-owned keys move with the identity; everything a human put on the target survives.
    const mergedSpecs: Record<string, unknown> = { ...targetSpecs };
    for (const key of AGENT_OWNED_SPECS_KEYS) {
      if (sourceSpecs[key] === undefined) delete mergedSpecs[key];
      else mergedSpecs[key] = sourceSpecs[key];
    }
    // The collision marker belongs to the row that WAS the duplicate; the merge is its resolution.
    for (const key of REPORT_DIAGNOSTIC_KEYS) delete mergedSpecs[key];
    // The key the transplant OVERWRITES, when the target had one of its own. A node holds exactly one
    // reporting key, so this value exists nowhere else the moment the write lands.
    const replacedTargetKey =
      target.reportingSource && target.externalId
        ? {
            reportingSource: target.reportingSource,
            externalId: target.externalId,
          }
        : undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.infraNode.update({
        where: { id: sourceId },
        data: {
          deletedAt: now,
          // Cleared so the archived row can be RESTORED: the pair is about to live on the target, and
          // the partial-unique index over live rows admits exactly one holder. The marker below keeps
          // the value for the audit trail.
          reportingSource: null,
          externalId: null,
          specs: {
            ...sourceSpecs,
            [INFRA_MERGED_INTO_MARKER]: {
              nodeId: target.id,
              label: target.label,
              externalId: source.externalId,
              reportingSource: source.reportingSource,
              at: now.toISOString(),
              ...(userId !== undefined ? { byUserId: userId } : {}),
              ...(replacedTargetKey ? { replacedTargetKey } : {}),
            },
          },
        },
      });
      await tx.infraNode.update({
        where: { id: targetNodeId },
        data: {
          source: 'AGENT',
          reportingSource: source.reportingSource,
          externalId: source.externalId,
          lastReportedAt: source.lastReportedAt,
          agentVersion: source.agentVersion,
          status: source.status,
          specs: mergedSpecs as Prisma.InputJsonValue,
          // Same rule the report path follows (#1081): a human-curated IP is never clobbered.
          ...(target.ipAddressSource !== 'MANUAL' && source.ipAddress
            ? { ipAddress: source.ipAddress, ipAddressSource: 'AGENT' as const }
            : {}),
        },
      });
    });

    this.logger.log(
      `Merged node ${sourceId} into ${targetNodeId}: reporting key ${source.reportingSource}/${source.externalId} transplanted, duplicate archived.` +
        (replacedTargetKey
          ? ` It REPLACED the target's own key ${replacedTargetKey.reportingSource}/${replacedTargetKey.externalId}, which is now held by no live node — a host still reporting under it returns as a new proposal.`
          : ''),
    );
    // The duplicate is off the map; the adopting node changed enough to re-project (ADR-0035).
    this.search.remove('infra', sourceId);
    void this.syncNodeToSearch(targetNodeId);
    return this.getNodeDetail(targetNodeId, principal);
  }

  /**
   * Other live nodes whose stored corroborating evidence shares a BURNED-IN fact with this one
   * (#1141) — the *"this looks like `srv-app-04` re-imaged — adopt?"* hint the review tray shows above
   * a fresh proposal. Read-only, best-effort and never blocking: it suggests a merge, it never
   * performs one.
   *
   * Empty for any node with no stored `identifiers[]`, which is every node an agent older than
   * contract v2 reported — those simply get no hint, never a wrong one.
   *
   * Two facts only: a matching serial or a matching MAC. A hostname match is deliberately NOT offered,
   * because recycling a hostname is a naming convention working as intended, and a hint that is usually
   * wrong teaches the operator to click past the one time it is right.
   *
   * ponytail: the candidate lookup is a jsonb containment filter with no supporting GIN index, so it is
   * a sequential scan over the node table. At the estate ADR-0074 targets (tens of nodes) that is far
   * cheaper than the index it would otherwise need to maintain on every report — add the index if a
   * fleet ever makes this the slow part. `matchedOn` is resolved by re-reading each CANDIDATE's
   * evidence (a handful of PK-addressed few-KB reads, bounded by {@link IDENTITY_MATCH_MAX}) rather
   * than by running one query per value, so the scan happens once.
   */
  async findIdentityMatches(id: string): Promise<InfraIdentityMatch[]> {
    await this.getNode(id); // 404 if missing/archived
    const evidence = (await this.storedNodeSpecs(id)).identity;
    const clauses = [
      ...evidence.serials.map((value) => identifierClause('serial', value)),
      ...evidence.macs.map((value) => identifierClause('mac', value)),
    ];
    if (clauses.length === 0) return [];

    const candidates = await this.prisma.infraNode.findMany({
      where: { id: { not: id }, OR: clauses },
      orderBy: { label: 'asc' },
      take: IDENTITY_MATCH_MAX,
      select: {
        id: true,
        label: true,
        kind: true,
        status: true,
        state: true,
      },
    });

    const matches: InfraIdentityMatch[] = [];
    for (const candidate of candidates) {
      const peer = (await this.storedNodeSpecs(candidate.id)).identity;
      // The serial wins when both match: it is burned into the board, a MAC rides on a card.
      const serial = evidence.serials.find((v) => peer.serials.includes(v));
      const mac = serial
        ? undefined
        : evidence.macs.find((v) => peer.macs.includes(v));
      const value = serial ?? mac;
      // Defensive: the containment filter matched but the re-read does not agree (a blob edited
      // between the two reads). Drop the candidate rather than claim a match we cannot name.
      if (value === undefined) continue;
      matches.push({
        ...candidate,
        matchedOn: serial !== undefined ? 'serial' : 'mac',
        value,
      });
    }
    return matches;
  }

  // ── Edges ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Open an edge between two nodes (ADR-0070 §3). Behaviors layered on the contract:
   *   - both endpoints must exist (live) → else 400 (a dangling edge is meaningless).
   *   - CONNECTS_TO is SYMMETRIC → canonicalize: store the lower `id` as source, regardless of input
   *     order, so the canonical-pair partial-unique backs uniqueness either way.
   *   - RUNS_ON is one-active-host-per-source → if the source already has an active RUNS_ON, this is a
   *     MIGRATION (ADR-0070 §3 / §4 UC-4): CLOSE the old (set endedAt) then OPEN the new, in one
   *     transaction. The partial-unique is the race-proof backstop (a concurrent open surfaces 409).
   *   - implausible (sourceKind→targetKind) pairs WARN (log), never block — the model stays generic.
   */
  async createEdge(data: CreateInfraEdge) {
    const [source, target] = await Promise.all([
      this.prisma.infraNode.findFirst({
        where: { id: data.sourceId },
        select: { id: true, kind: true },
      }),
      this.prisma.infraNode.findFirst({
        where: { id: data.targetId },
        select: { id: true, kind: true },
      }),
    ]);
    if (!source || !target) {
      throw new BadRequestException(
        'Both the source and target nodes must exist (and not be archived) to connect them.',
      );
    }

    // WARN — never block — on an implausible pair, keeping the model generic (ADR-0070 §3).
    if (!isPlausibleEdge(data.kind, source.kind, target.kind)) {
      this.logger.warn(
        `Implausible ${data.kind} edge created: ${source.kind} → ${target.kind} (${data.sourceId} → ${data.targetId}). Allowed but flagged (ADR-0070 §3).`,
      );
    }

    let { sourceId, targetId } = data;
    // CONNECTS_TO is symmetric: canonicalize so the lower id is always the source (input-order-proof).
    if (data.kind === 'CONNECTS_TO' && sourceId > targetId) {
      [sourceId, targetId] = [targetId, sourceId];
    }

    if (data.kind === 'RUNS_ON') {
      return this.openRunsOnEdge(sourceId, targetId);
    }

    return this.tryOpenEdge({ sourceId, targetId, kind: data.kind });
  }

  /**
   * RUNS_ON migration (ADR-0070 §4 UC-4): close any active RUNS_ON for the source, then open the new
   * one — atomically, so the one-active-host invariant holds across the swap. The DB partial-unique is
   * still the backstop: if a concurrent open races in, the second insert hits P2002 → a friendly 409.
   */
  private async openRunsOnEdge(sourceId: string, targetId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.infraEdge.updateMany({
          where: { sourceId, kind: 'RUNS_ON', endedAt: null },
          data: { endedAt: new Date() },
        });
        return tx.infraEdge.create({
          data: { sourceId, targetId, kind: 'RUNS_ON' },
        });
      });
    } catch (err) {
      throw this.mapEdgeUniqueConflict(err);
    }
  }

  /** Open a non-RUNS_ON edge, mapping the CONNECTS_TO canonical-pair unique collision to a 409. */
  private async tryOpenEdge(data: {
    sourceId: string;
    targetId: string;
    kind: InfraEdgeKind;
  }) {
    try {
      return await this.prisma.infraEdge.create({ data });
    } catch (err) {
      throw this.mapEdgeUniqueConflict(err);
    }
  }

  /**
   * Map a partial-unique P2002 from the infra_edges indexes to a friendly 409 (ADR-0070 §3). The two
   * raw indexes surface their NAME as `meta.target` (adapter-pg, raw SQL indexes Prisma can't see):
   *   - infra_edges_source_active_runs_on_key  → a duplicate active RUNS_ON for the source.
   *   - infra_edges_connects_to_pair_active_key → a duplicate active CONNECTS_TO for the canonical pair.
   * Anything else propagates unchanged (the global filter handles it).
   */
  private mapEdgeUniqueConflict(err: unknown): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const target = err.meta?.target;
      const name = Array.isArray(target) ? target.join(',') : String(target);
      if (name.includes('runs_on')) {
        return new ConflictException(
          'This source already has an active host (RUNS_ON). Close the existing one first, or the migration retry raced — try again.',
        );
      }
      if (name.includes('connects_to')) {
        return new ConflictException(
          'These two nodes are already connected (CONNECTS_TO is symmetric — the pair already has an active connection).',
        );
      }
    }
    return err;
  }

  /** Close an edge: set `endedAt` (the migration/lifecycle marker, ADR-0019). 404 if missing/closed. */
  async closeEdge(id: string) {
    const edge = await this.prisma.infraEdge.findUnique({ where: { id } });
    if (!edge) {
      throw new NotFoundException(`Infra edge ${id} not found`);
    }
    if (edge.endedAt !== null) {
      throw new ConflictException('This edge is already closed.');
    }
    return this.prisma.infraEdge.update({
      where: { id },
      data: { endedAt: new Date() },
    });
  }

  /**
   * List a node's edges (ADR-0070 v1 edge history). `activeOnly` (default) returns only open edges
   * (endedAt null); pass false for the full history including closed ones (migrations). Covers edges
   * where the node is EITHER endpoint (source or target), newest first.
   */
  async listEdgesForNode(nodeId: string, activeOnly = true) {
    await this.getNode(nodeId);
    return this.prisma.infraEdge.findMany({
      where: {
        OR: [{ sourceId: nodeId }, { targetId: nodeId }],
        ...(activeOnly ? { endedAt: null } : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  // ── Impact / blast-radius (ADR-0070 §7) ───────────────────────────────────────────────────────────

  /**
   * Blast radius: "if this node goes down, what is affected?" The downstream set is every node that
   * RUNS_ON or DEPENDS_ON the root, transitively — i.e. we walk the INVERSE of those edges (start at
   * the root, follow edges whose TARGET is a frontier node back to their SOURCE), over ACTIVE edges
   * only (`endedAt IS NULL`), skipping soft-deleted nodes. Returns each affected node once, at its
   * MINIMUM hop count from the root (ADR-0070 §7 / InfraImpactResponse).
   *
   * ponytail: the graph traversal is ONE recursive CTE in Postgres (`$queryRaw`) — never an N+1 of
   * per-level Prisma queries in app code. The CTE is:
   *   - CYCLE-SAFE — it threads a `path` array of visited ids and only recurses into a neighbour NOT
   *     already on that path, so a cycle (A→B→A) terminates instead of looping forever.
   *   - DEPTH-BOUNDED — a hard ceiling of {@link IMPACT_MAX_DEPTH} hops is a belt-and-suspenders cap on
   *     top of the path guard (a malformed/huge estate can never spin an unbounded recursion).
   * The outer query then collapses to the MIN depth per affected node and joins back for display facts.
   */
  async getImpact(id: string): Promise<InfraImpactResponse> {
    await this.getNode(id); // 404 if the root is missing or soft-deleted.

    // The downstream/inverse traversal kinds (ADR-0070 §7). Bound as a SQL array literal cast to the
    // enum type so the IN-list is parameterized, not concatenated. MEMBER_OF is included (#802): a
    // CLUSTER/group going down ⇒ its members are surfaced (member=sourceId, group=targetId, so a group
    // root surfaces its members at depth 1) — an edge-derived heuristic, not a hand-verified guarantee.
    // BACKS_UP_TO and CONNECTS_TO are deliberately excluded: a backup target failing doesn't take down
    // the primary, and CONNECTS_TO is symmetric (no failure direction).
    const kinds: InfraEdgeKind[] = ['RUNS_ON', 'DEPENDS_ON', 'MEMBER_OF'];

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        label: string;
        kind: InfraNodeKind;
        status: InfraNodeStatus;
        depth: number;
      }>
    >(Prisma.sql`
      WITH RECURSIVE impact AS (
        -- Seed: the root at depth 0 (it is the cycle-path origin; excluded from the result below).
        SELECT
          n."id",
          0 AS depth,
          ARRAY[n."id"] AS path
        FROM "infra_nodes" n
        WHERE n."id" = ${id} AND n."deletedAt" IS NULL

        UNION ALL

        -- Step: a node SOURCE that RUNS_ON / DEPENDS_ON a frontier node (edge TARGET = frontier), over
        -- ACTIVE edges only, where the source is live and NOT already on the path (cycle guard) and we
        -- are under the depth ceiling.
        SELECT
          e."sourceId",
          impact.depth + 1,
          impact.path || e."sourceId"
        FROM impact
        JOIN "infra_edges" e
          ON e."targetId" = impact."id"
         AND e."endedAt" IS NULL
         AND e."kind" = ANY(${kinds}::"InfraEdgeKind"[])
        JOIN "infra_nodes" src
          ON src."id" = e."sourceId"
         AND src."deletedAt" IS NULL
        WHERE impact.depth < ${IMPACT_MAX_DEPTH}
          AND NOT (e."sourceId" = ANY(impact.path))
      )
      SELECT
        n."id",
        n."label",
        n."kind",
        n."status",
        MIN(impact.depth)::int AS depth
      FROM impact
      JOIN "infra_nodes" n ON n."id" = impact."id"
      WHERE impact.depth > 0          -- drop the root itself; only the affected set ships.
      GROUP BY n."id", n."label", n."kind", n."status"
      ORDER BY depth ASC, n."label" ASC
    `);

    const affected: InfraImpactNode[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      status: r.status,
      depth: r.depth,
    }));
    return { rootId: id, affected };
  }
}

/**
 * Hard recursion ceiling for the impact CTE (ADR-0070 §7). The `path` cycle-guard already terminates
 * any cycle; this is a defence-in-depth cap so even a pathologically deep (or malformed) estate can
 * never spin an unbounded recursion. 64 hops dwarfs any realistic host→VM→container→… chain in a
 * 5–20-person estate — ponytail: a generous constant, not a tunable knob nobody will turn.
 */
const IMPACT_MAX_DEPTH = 64;

/**
 * Is this error a unique-serial collision on `Asset.serial` (#1081)? A P2002 whose target names the
 * `assets_serial_active_key` partial-unique — i.e. a discovered serial already belongs to another live
 * asset. `confirmNode` uses it to fall back to leaving the serial in specs instead of failing the
 * confirm. Anything else is not a serial collision.
 */
function isSerialUniqueCollision(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return false;
  }
  const target = err.meta?.target;
  const name = Array.isArray(target) ? target.join(',') : String(target);
  return name.toLowerCase().includes('serial');
}

/**
 * What an upgraded server could not make sense of in a report (#1138) — recorded on the NODE, not
 * lost. `droppedPaths` are the (bounded, truncated) wire paths whose data did not survive parsing;
 * `coercedPaths` the ones whose value this build had to change to accept — a silently-coerced enum is
 * skew too, and `os.family` is the case that matters, since the contract requires it precisely so no
 * consumer re-derives the platform. `agentAhead` says whether the reporting binary is a strictly
 * newer build than this server, which is the likeliest cause and the one the operator can act on;
 * `serverVersion` names the build that did the dropping, since the node records the agent's version
 * but never the server's.
 */
// A `type`, not an `interface`, on purpose: only a type alias gets an implicit index signature, which
// is what Prisma's `InputJsonValue` requires of anything written into a jsonb column.
export type AgentReportSkew = {
  droppedPaths?: string[];
  coercedPaths?: string[];
  agentAhead: boolean;
  serverVersion: string;
};

/**
 * The inventory `specs` blob an agent report lands (#1081): host facts + optional software list + the
 * report timestamp, plus the two REPORT DIAGNOSTICS (#1138) — what the collector could not do
 * (`diagnostics`) and what the server could not understand (`agentSkew`). A concrete type (not just
 * `Prisma.InputJsonValue`) so the linked-Asset specs sync can spread its keys and the node/asset
 * snapshots stay identical.
 */
type AgentReportSpecsBlob = {
  host: AgentReportHost;
  software?: AgentReport['software'];
  /**
   * The fingerprint of the stored `software` list (#1142) — computed by the SERVER over the list it
   * stored, so the next report can be compared to it without reading the list back, and so the
   * comparison does not depend on the client having sent a fingerprint of its own. Present only while
   * a list is; never written beside an absent one, or a stored fingerprint would outlive the thing it
   * describes and let a later `unchanged` claim corroborate against nothing.
   */
  softwareHash?: string;
  reportedAt: string;
  diagnostics?: AgentReport['diagnostics'];
  agentSkew?: AgentReportSkew;
  identityConflict?: AgentReportIdentityConflict;
};

/**
 * A CONTAINER child's inventory blob (#1139) — deliberately NOT the host shape. No `host` key, because
 * a container is not a host: the web `container` projection (`getAgentContainerFacts`) reads exactly
 * this and renders it as a Container panel on the node drill-in and, once confirmed with asset
 * tracking on, on the Asset detail page.
 */
type ContainerSpecsBlob = {
  container: AgentContainer;
  reportedAt: string;
};

/**
 * Why this node exists as a SEPARATE row from the one that owns its reported `externalId` (#1141).
 * Stamped on the colliding host's node, and re-stamped on every report for as long as the collision
 * lasts — so it SELF-HEALS: the moment the operator runs the remedy the nudge named for that host's
 * platform (`systemd-firstboot --setup-machine-id` on Linux, `sysprep /generalize` on Windows), the
 * clone reports a genuinely new identity key, takes the ordinary unknown-key path, and the marker is
 * gone with the next blob rewrite.
 *
 * `reportedExternalId` is the value the host actually claims, kept because the node's own `externalId`
 * is the DERIVED key — without this the original is nowhere on the row.
 */
export type AgentReportIdentityConflict = {
  reportedExternalId: string;
  peerNodeId: string;
  peerLabel: string;
  discriminator: string;
  /**
   * When the collision was FIRST seen — read back and carried across every re-stamp, so the marker
   * says how long it has been true rather than only "still true as of the last check-in".
   */
  detectedAt: string;
};

/**
 * The blob keys that describe the REPORT rather than the HOST (#1138). `Asset.specs` is the inventory
 * snapshot an operator reads, and neither "the collector ran unprivileged" nor "the server did not
 * understand `host.tpmVersion`" is an inventory fact. They stay on the node, where the reporting
 * provenance already lives — and they self-heal there, since the node's blob is rewritten whenever the
 * facts change while an Asset's is merged.
 *
 * A merge (#1141) clears them from the ADOPTING node too, which is why this list is separate from
 * {@link NODE_ONLY_SPECS_KEYS}: everything here is discarded on a merge, while a node's software
 * fingerprint has to travel WITH the list it describes.
 */
const REPORT_DIAGNOSTIC_KEYS = [
  'diagnostics',
  'agentSkew',
  // "Another host claims my machine-id" (#1141) describes the REPORT's identity, not the host's
  // hardware, so it follows the same rule: it stays on the node and never reaches an Asset's specs,
  // where a merged (never rewritten) blob would keep it long after the collision was resolved.
  'identityConflict',
] as const;

/**
 * Everything an Asset's `specs` must never receive — the report diagnostics plus the software
 * fingerprint (#1142). The fingerprint is server/agent bookkeeping about a check-in, not a fact an
 * operator reads, and the Asset panel renders any key it does not recognise under **Custom fields**,
 * a heading that means "a human typed this".
 */
const NODE_ONLY_SPECS_KEYS = [
  ...REPORT_DIAGNOSTIC_KEYS,
  'softwareHash',
] as const;

/**
 * The `specs` keys an agent report OWNS (#1141) — the ones a merge transplants from the duplicate onto
 * the node adopting its identity, leaving every human-added key on the target intact. A superset of
 * what {@link InfraService.syncAssetSpecs} replaces on the host path, by `softwareHash` — node
 * bookkeeping that never reaches an Asset, but which on a NODE must move WITH the list it describes,
 * since a transplanted list under the adopting node's old fingerprint would make the next comparison
 * read the wrong thing (recoverable — the ack asks for a resend — but avoidable here for free).
 *
 * By TWO keys on a report that does not OWN the list: the host path passes
 * `host`/`software`/`reportedAt` only when {@link SpecsWritePlan.softwareOwned} is set, and
 * `host`/`reportedAt` alone otherwise, leaving the Asset's own copy exactly as it is. That is every
 * `preserve` EXCEPT the one that re-embeds the stored list into the blob it writes — having read the
 * list back, that branch knows what the node holds and may say so.
 */
const AGENT_OWNED_SPECS_KEYS = [
  'host',
  'software',
  'softwareHash',
  'reportedAt',
] as const;

/**
 * The merge provenance stamped on the ARCHIVED duplicate (#1141). There is no `InfraNodeHistory`
 * table (ADR-0074 §8), so the soft-deleted row IS the audit trail — and unlike the adopting node, it
 * can never be overwritten by a later report, because a soft-deleted node no longer matches the dedup
 * lookup. Underscore-prefixed like `_infraAutoCreated`, marking it as provenance rather than a fact.
 *
 * It carries `{ nodeId, label, externalId, reportingSource, at, byUserId?, replacedTargetKey? }` — the
 * reporting key the archived row gave up (its own columns are cleared so it stays restorable), and,
 * when the target already had one, the key the transplant destroyed.
 */
const INFRA_MERGED_INTO_MARKER = '_infraMergedInto';

/** How many adoption candidates one node may surface — a hint list, not a search result. */
const IDENTITY_MATCH_MAX = 5;

/**
 * "Some live node's stored `host.identifiers` contains exactly this (kind, value)" — jsonb containment
 * (`@>`), which is subset-wise, so a stored entry carrying an extra `namespace` still matches (#1141).
 */
function identifierClause(
  kind: 'serial' | 'mac',
  value: string,
): Prisma.InfraNodeWhereInput {
  return {
    specs: {
      path: ['host', 'identifiers'],
      array_contains: [{ kind, value }],
    },
  };
}

/** The lean owner-user shape AssetAssignmentsService inlines when `includeUser: true`. */
interface AssignmentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  deletedAt: Date | null;
}
