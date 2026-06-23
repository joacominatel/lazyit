import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  isPlausibleEdge,
  type CreateInfraEdge,
  type CreateInfraNode,
  type InfraEdgeKind,
  type InfraImpactNode,
  type InfraImpactResponse,
  type InfraNodeKind,
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
import { SearchService } from '../search/search.service';
import { projectInfraNode } from '../search/search.documents';
import { parsePageQuery } from '../common/parse-page-query';
import type { Principal } from '../auth/principal';

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
    private readonly search: SearchService,
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

  /** A single page-less list of nodes, newest first, filtered; soft-deleted excluded by the extension. */
  listNodes(filters: InfraNodeFilters = {}) {
    return this.prisma.infraNode.findMany({
      where: {
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.state ? { state: filters.state } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
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
    const childEdges = await this.prisma.infraEdge.findMany({
      where: { targetId: id, kind: 'RUNS_ON', endedAt: null },
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

    return {
      ...node,
      assetName,
      owners,
      articleLinks,
      // ponytail: no asset→secret linkage exists in the data model (verified against the Secret Manager
      // schema), so there is nothing to surface yet. The shape is fixed (handles only, INV-10) so a
      // future linkage (ADR-0070 §6) needs no contract change. NEVER return ciphertext/iv/authTag.
      secretRefs: [] as InfraSecretRef[],
      children,
    };
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
    // enum type so the IN-list is parameterized, not concatenated.
    const kinds: InfraEdgeKind[] = ['RUNS_ON', 'DEPENDS_ON'];

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

/** The lean owner-user shape AssetAssignmentsService inlines when `includeUser: true`. */
interface AssignmentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  deletedAt: Date | null;
}
