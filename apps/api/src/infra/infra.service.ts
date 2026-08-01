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
  disambiguateExternalId,
  hostIdentityEvidence,
  identityDiscriminator,
  inferNodeKind,
  isClonedMachineId,
  isNewerVersion,
  isPlausibleEdge,
  primaryIp,
  sanitizeSerial,
  type AgentContainer,
  type AgentReport,
  type AgentReportAck,
  type AgentReportHost,
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
  type InfraIdentityMatch,
  type InfraImpactNode,
  type InfraImpactResponse,
  type InfraNodeChild,
  type InfraNodeKind,
  type InfraAutoConfirmCandidate,
  type InfraNodeState,
  type InfraNodeStatus,
  type InfraSecretRef,
  type UpdateInfraNode,
} from '@lazyit/shared';
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
   */
  async ingestReport(
    report: AgentReport,
    principal?: Principal,
    rawBody?: unknown,
  ): Promise<AgentReportAck> {
    // The inventory blob (ADR-0074 §2 / ADR-0007 jsonb posture): host facts + software under clear
    // keys, plus the report timestamp for provenance. Stored verbatim — validated already by
    // `AgentReportSchema` at the controller. `software` is omitted when the agent couldn't list it.
    // `agentVersion` is NOT duplicated here (#907): it now lives in its own queryable column below.
    // Held as a plain object (not just `Prisma.InputJsonValue`) so the linked-Asset specs sync can
    // spread its keys (#1081).
    const skew = this.agentSkew(report, rawBody);
    const blob: AgentReportSpecsBlob = {
      host: report.host,
      ...(report.software !== undefined ? { software: report.software } : {}),
      reportedAt: report.reportedAt,
      // What the COLLECTOR could not do (#1138). Persisted beside the facts, because an empty
      // serial/model column is only an ANSWER ("web-03 reports unprivileged") if the reason survived
      // the request. Overwritten wholesale each report, exactly like the facts themselves.
      ...(report.diagnostics !== undefined
        ? { diagnostics: report.diagnostics }
        : {}),
      ...(skew !== undefined ? { agentSkew: skew } : {}),
    };
    const specs = blob as Prisma.InputJsonValue;
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
      },
    });

    if (existing) {
      // CORROBORATE before merging (#1141). The dedup key is machine-id twice, so a baked
      // `/etc/machine-id` makes every clone of a template match here and write to ONE row.
      const incoming = hostIdentityEvidence(report.host);
      const stored = await this.storedHostIdentity(existing.id);
      if (isClonedMachineId(stored, incoming)) {
        return this.ingestCollidingHost(
          existing,
          stored,
          incoming,
          report,
          blob,
          now,
          primaryIpAddress,
          principal,
        );
      }
      // Known host: refresh inventory facts + liveness ONLY. Curation (state/label/x/y/asset) is the
      // human's and is deliberately left untouched. NOT throttled — it adds no row (#1134).
      const ack = await this.refreshKnownNode(
        existing,
        blob,
        now,
        report.agentVersion,
        primaryIpAddress,
      );
      return this.reconcileContainers(ack, report, now, principal);
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
          specs,
        },
        select: { id: true, state: true },
      });
      void this.syncNodeToSearch(created.id);
      // The ONE place a saved rule can act on a HOST (#1145): a node that has just been proposed, in
      // the same request that proposed it. Nothing here can reach a node that already existed.
      const state = await this.autoConfirmProposal(created.id, created.state, {
        hostname: report.host.hostname,
        ipAddress: primaryIpAddress ?? null,
        kind: proposedKind,
        isContainerChild: false,
      });
      return this.reconcileContainers(
        { nodeId: created.id, state, accepted: true },
        report,
        now,
        principal,
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
          select: { id: true, assetId: true, ipAddressSource: true },
        });
        // No loop: after P2002 the row exists. If it somehow doesn't (e.g. it was soft-deleted in the
        // same instant so findFirst can't see it), rethrow the original error rather than inventing one.
        if (raced) {
          const ack = await this.refreshKnownNode(
            raced,
            blob,
            now,
            report.agentVersion,
            primaryIpAddress,
          );
          return this.reconcileContainers(ack, report, now, principal);
        }
      }
      throw err;
    }
  }

  /**
   * What this build did NOT understand about a report (#1138) — `undefined` when it understood all of
   * it, which is the overwhelmingly normal case and writes nothing.
   *
   * Loosening the contract root from `strictObject` to `object` traded a hard 400 (the host disappears
   * from the inventory) for silent stripping. Silence is the part that would be dangerous: a typo'd
   * key is indistinguishable from a field the server simply predates, and #1142 will give an ABSENT
   * key semantics of its own ("unchanged"). So the drop is recorded on the node, inside the existing
   * `specs` blob — no column, no migration, and it self-heals, since the blob is rewritten wholesale
   * on every report (one clean check-in clears it).
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
   */
  private async refreshKnownNode(
    node: { id: string; assetId: string | null; ipAddressSource: string },
    blob: AgentReportSpecsBlob,
    now: Date,
    agentVersion: string,
    primaryIpAddress: string | undefined,
  ): Promise<AgentReportAck> {
    const data: Prisma.InfraNodeUncheckedUpdateInput = {
      specs: blob,
      status: 'ONLINE',
      lastReportedAt: now,
      agentVersion,
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
    // Keep the linked Asset's specs snapshot fresh on every report (agent-owned facts only).
    if (node.assetId) {
      await this.syncAssetSpecs(node.assetId, blob);
    }
    void this.syncNodeToSearch(updated.id);
    return { nodeId: updated.id, state: updated.state, accepted: true };
  }

  /**
   * The corroborating identity a node last reported, read STRAIGHT out of its stored `specs` blob
   * (#1141). No schema change was needed for any of this: contract v2 already stores the whole `host`
   * block, `identifiers[]` included, on every report.
   *
   * A raw sub-select rather than `select: { specs: true }` on purpose. `specs` is the entire inventory
   * blob — up to 5,000 packages on a real Linux box — and this runs on the KNOWN-host path, i.e. once
   * per host every 15 minutes forever. Reading the whole column back would roughly double the I/O of
   * the hot path to compare four short strings; `specs->'host'` is a few KB. Same lesson as #1135, one
   * layer down. Parameterized, and addressed by a primary key we resolved through the soft-delete-scoped
   * `findFirst` a moment earlier.
   */
  private async storedHostIdentity(
    nodeId: string,
  ): Promise<HostIdentityEvidence> {
    const rows = await this.prisma.$queryRaw<Array<{ host: unknown }>>(
      Prisma.sql`SELECT "specs"->'host' AS host FROM "infra_nodes" WHERE "id" = ${nodeId}`,
    );
    // Tolerant by construction: a missing row, a null `specs` and a hand-edited blob all read as
    // "no evidence", which `isClonedMachineId` treats as "nothing to corroborate".
    return hostIdentityEvidence(rows[0]?.host);
  }

  /**
   * When this node's collision was FIRST detected (#1141), or `undefined` if it carries no marker.
   *
   * The marker is re-stamped on every report (see {@link ingestCollidingHost}), and a marker whose
   * timestamp moved with it would only ever say "still colliding" — the operator also needs "and it
   * has been true since the 10th". So the re-stamp reads the first detection back and keeps it.
   *
   * Same posture as {@link storedHostIdentity}: a `->>` sub-select rather than reading the whole
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
   *     as the collision lasts. The blob is rewritten wholesale on each check-in, so a marker written
   *     only at creation would be gone 15 minutes later — leaving the operator holding a notification
   *     that points at a node showing no evidence of why. `detectedAt` keeps the FIRST detection
   *     across re-stamps. It still SELF-HEALS: once the clone is given a real machine-id it takes the
   *     ordinary unknown-key path, nothing re-stamps, and the next blob rewrite drops the marker.
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
    now: Date,
    primaryIpAddress: string | undefined,
    principal?: Principal,
  ): Promise<AgentReportAck> {
    const discriminator = identityDiscriminator(incoming);
    if (discriminator === undefined) {
      // Unreachable: the rule that got us here requires a serial AND a MAC on both sides. Falling
      // back to the ordinary refresh rather than throwing keeps the machine-facing path total.
      return this.refreshKnownNode(
        { id: peer.id, assetId: null, ipAddressSource: 'AGENT' },
        blob,
        now,
        report.agentVersion,
        primaryIpAddress,
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
    }): Promise<AgentReportAck> => {
      const conflict: AgentReportIdentityConflict = {
        ...conflictFacts,
        detectedAt:
          (await this.storedConflictDetectedAt(node.id)) ?? now.toISOString(),
      };
      return this.refreshKnownNode(
        node,
        { ...blob, identityConflict: conflict },
        now,
        report.agentVersion,
        primaryIpAddress,
      );
    };

    // Does this clone already have a node of its own? (Its second and every later report.)
    const own = await this.prisma.infraNode.findFirst({
      where: { reportingSource: report.reportingSource, externalId },
      select: { id: true, assetId: true, ipAddressSource: true },
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
          specs: { ...blob, identityConflict: conflict },
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
          select: { id: true, assetId: true, ipAddressSource: true },
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

    this.logger.warn(
      `Two hosts are reporting externalId ${report.externalId}: "${peer.label}" (${peer.id}) and ` +
        `"${report.host.hostname}" (${created.id}). Almost always a cloned VM template with a baked ` +
        `/etc/machine-id — nothing was merged; the second host landed as a separate PENDING proposal.`,
    );
    // Best-effort, exactly like the staleness sweeper's nudge: a failed emit must never fail a report.
    await this.notifications.emit({
      type: 'infra.identity_conflict',
      dedupeKey: `infra.identity_conflict:${peer.id}:${discriminator}`,
      severity: 'warning',
      title: `Two hosts share one machine-id: ${report.host.hostname} and ${peer.label}`,
      // The remedy leads, deliberately: the bell renders a summary as ONE truncated line (full text
      // on hover), so whatever an operator can act on has to be in the first few words. "Identity
      // conflict detected" as an opener would leave them exactly as stuck as the silence did.
      summary:
        `Run \`systemd-firstboot --setup-machine-id\` on the clones — "${report.host.hostname}" and ` +
        `"${peer.label}" report the same machine-id but a different hardware serial AND different ` +
        `network cards, so they are two servers, not one. ` +
        // Hostname is NOT part of the rule (a golden image bakes it in alongside the machine-id), but
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
    return { nodeId: created.id, state: created.state, accepted: true };
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
    principal?: Principal,
  ): Promise<AgentReportAck> {
    const containers = report.host.containers;
    if (containers === undefined) return ack;
    try {
      await this.applyContainerTopology(
        ack.nodeId,
        containers,
        report,
        now,
        principal,
      );
    } catch (err) {
      this.logger.warn(
        `Container topology for ${report.host.hostname} could not be reconciled — the host itself still reported. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return ack;
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
    principal?: Principal,
  ): Promise<void> {
    // Every child this reporter already has for THIS host. Scoped by the prefix, because container
    // names are only unique within one runtime: two hosts both running `redis` are two containers,
    // and a host-less key would fuse them into one node whose RUNS_ON edge flapped between hosts.
    const known: { id: string; externalId: string | null }[] =
      (await this.prisma.infraNode.findMany({
        where: {
          reportingSource: report.reportingSource,
          externalId: {
            startsWith: containerExternalIdPrefix(report.externalId),
          },
        },
        select: { id: true, externalId: true },
      })) ?? [];
    const knownByExternalId = new Map(
      known.flatMap((n) =>
        n.externalId ? [[n.externalId, n.id] as const] : [],
      ),
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
      // The child's whole inventory blob. Rewritten wholesale each report, exactly like the host's.
      // No `host` key, because a container is not a host: the web `container` projection
      // (`getAgentContainerFacts`) reads this shape and renders it as a Container panel — on the node
      // drill-in and, once confirmed with asset tracking on, on the Asset detail page. Keep the
      // `container` key: without it both surfaces fall back to the raw custom-fields grid, which
      // JSON.stringifies the blob.
      const specs = {
        container,
        reportedAt: report.reportedAt,
      } as unknown as Prisma.InputJsonValue;
      // A LIVENESS fact the agent owns, exactly like the host node's `status` on check-in.
      const status = containerNodeStatus(container.state);

      const existingId = knownByExternalId.get(externalId);
      if (existingId !== undefined) {
        // Facts + liveness only. `kind`/`label`/`state`/position stay the human's, on the same rule
        // `refreshKnownNode` applies to hosts.
        await this.prisma.infraNode.update({
          where: { id: existingId },
          data: {
            specs,
            status,
            lastReportedAt: now,
            agentVersion: report.agentVersion,
          },
        });
        childIds.push(existingId);
        void this.syncNodeToSearch(existingId);
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
          specs,
        },
        select: { id: true },
      });
      childIds.push(created.id);
      void this.syncNodeToSearch(created.id);
      // The child half of #1145. A container child is offered to the matcher under its CONTAINER
      // NAME, with no IP of its own — the host owns the address, and pretending the child reported
      // one would let a subnet rule confirm containers on the strength of their host's wire.
      await this.autoConfirmProposal(created.id, 'PENDING', {
        hostname: container.name,
        ipAddress: null,
        kind: 'CONTAINER',
        isContainerChild: true,
      });
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
   * NEVER FAILS THE REPORT, on the same reasoning as the container reconcile: the node row is already
   * durable, so a failure here degrades to a node that stays PENDING — which is where it was going
   * anyway, and which the operator can act on — while throwing would make the host vanish from the
   * inventory.
   */
  private async autoConfirmProposal(
    nodeId: string,
    currentState: InfraNodeState,
    candidate: InfraAutoConfirmCandidate,
  ): Promise<InfraNodeState> {
    try {
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
   * Refresh a linked Asset's `specs` inventory snapshot from a fresh report (#1081) — the host facts
   * blob (`host`/`software`/`reportedAt`), so the Asset inventory panel mirrors the node on every
   * check-in. Merges over the existing specs: the three agent-owned keys are replaced wholesale (a
   * report that dropped `software` drops it here too), while every human-added key (custom fields, the
   * `_infraAutoCreated` marker, a serial fallback) is preserved. Writes `specs` DIRECTLY (not via
   * AssetsService.update) on purpose: this is an agent fact refresh, so it must NOT emit a
   * SPECS_CHANGED history event on every report (that would flood the asset's audit trail) and must
   * NEVER touch the Asset's human-owned serial/name/modelId. A soft-deleted asset is skipped — the
   * soft-delete extension scopes `findFirst`, so a detached/archived asset simply resolves to null.
   *
   * The {@link REPORT_DIAGNOSTIC_KEYS} (#1138) are deliberately NOT carried over, and are stripped if
   * an older build left one behind.
   */
  private async syncAssetSpecs(
    assetId: string,
    blob: AgentReportSpecsBlob,
  ): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { specs: true },
    });
    if (!asset) return; // soft-deleted / detached — nothing to refresh.
    const facts: Omit<
      AgentReportSpecsBlob,
      (typeof REPORT_DIAGNOSTIC_KEYS)[number]
    > = {
      host: blob.host,
      ...(blob.software !== undefined ? { software: blob.software } : {}),
      reportedAt: blob.reportedAt,
    };
    const existing = (asset.specs ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    delete merged.host;
    delete merged.software;
    delete merged.reportedAt;
    for (const key of REPORT_DIAGNOSTIC_KEYS) delete merged[key];
    Object.assign(merged, facts);
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
      // Same rule as the repeat-report refresh (#1138): the report diagnostics stay on the node. This
      // is the path that mints the Asset, so without the strip the very first thing a confirmed host's
      // inventory snapshot carries is a diagnostic about a report the server half-understood — and
      // unlike the node's blob, an Asset's specs are MERGED, so it would never clear itself.
      for (const key of REPORT_DIAGNOSTIC_KEYS) delete assetSpecs[key];
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
   */
  async updateNode(id: string, data: UpdateInfraNode, principal?: Principal) {
    const node = await this.getNode(id);

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
   *  - **Re-image.** Reinstalling the OS on the same box mints a new `/etc/machine-id`, so the host
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
   * whose `specs` are rewritten wholesale every 15 minutes.
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
    const evidence = await this.storedHostIdentity(id);
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
      const peer = await this.storedHostIdentity(candidate.id);
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
  reportedAt: string;
  diagnostics?: AgentReport['diagnostics'];
  agentSkew?: AgentReportSkew;
  identityConflict?: AgentReportIdentityConflict;
};

/**
 * Why this node exists as a SEPARATE row from the one that owns its reported `externalId` (#1141).
 * Stamped on the colliding host's node, and re-stamped on every report for as long as the collision
 * lasts — so it SELF-HEALS: the moment the operator runs `systemd-firstboot --setup-machine-id`, the
 * clone reports a genuinely new machine-id, takes the ordinary unknown-key path, and the marker is
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
 * The blob keys that describe the REPORT rather than the HOST (#1138). One list, because both places
 * that copy a node's inventory into an `Asset` must strip exactly the same set: `Asset.specs` is the
 * inventory snapshot an operator reads, and neither "the collector ran unprivileged" nor "the server
 * did not understand `host.tpmVersion`" is an inventory fact. They stay on the node, where the
 * reporting provenance already lives — and they self-heal there, since the node's blob is rewritten
 * wholesale on every report while an Asset's is merged.
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
 * The `specs` keys an agent report OWNS (#1141) — the ones a merge transplants from the duplicate onto
 * the node adopting its identity, leaving every human-added key on the target intact. Deliberately the
 * same three keys {@link InfraService.syncAssetSpecs} replaces wholesale: a node's agent-owned facts
 * and an Asset's agent-owned facts must not drift into two different lists.
 */
const AGENT_OWNED_SPECS_KEYS = ['host', 'software', 'reportedAt'] as const;

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
