import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentPolicyOverrideSchema,
  SOFTWARE_WATCH_LIMIT,
  compareVersionText,
  matchesAnyGlob,
  normalizeSoftwareName,
  pageOf,
  resolveAgentPolicy,
  summarizeSoftwareWatch,
  type AgentPolicyOverride,
  type CreateSoftwareWatch,
  type Page,
  type PageQuery,
  type SoftwareWatch,
  type SoftwareWatchHost,
  type SoftwareWatchPresence,
  type SoftwareWatchSummary,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isHumanPrincipal, type Principal } from '../auth/principal';
import { AgentPolicyService } from './agent-policy.service';
import { infraNodeRoleWhere } from './infra-node-role';

/**
 * WHICH nodes a watch is answered over: every live, agent-reported HOST. Exported so the spec pins it.
 *
 *  - `source: 'AGENT'` — a manual node has no agent and therefore no package list; counting it would
 *    turn every hand-drawn switch into an "unknown" row.
 *  - `role: HOST` — container and hypervisor-guest children carry `{ container }` / `{ guest }` blobs,
 *    never a package list (#1139 / ADR-0095), and are told apart by their reporting key, not by
 *    `kind` (AUD-057). The same predicate the fleet view counts.
 *  - soft-deleted nodes are excluded by the read extension (ADR-0032), which scopes this `findMany`.
 *
 * PENDING and OFFLINE hosts are deliberately IN: the last stored list of an offline host is still the
 * best evidence there is, and each host row carries its liveness so the reader can weigh it.
 *
 * RETIRED hosts are OUT (#1701, epic #1146 Q11): a decommissioned server is not part of the estate,
 * so it is neither a host running a version nor a host "missing" the package. OFFLINE is not retired —
 * an offline host stays in, as above.
 */
export const SOFTWARE_WATCH_POPULATION_WHERE = {
  source: 'AGENT',
  retiredAt: null,
  ...infraNodeRoleWhere('HOST'),
} satisfies Prisma.InfraNodeWhereInput;

const WATCH_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  createdById: true,
  // Selected (a to-one relation cannot be `where`-filtered) so the flatten can gate the name on a LIVE
  // author — the auto-confirm rule's rule.
  createdBy: { select: { firstName: true, lastName: true, deletedAt: true } },
} as const;

type WatchRow = {
  id: string;
  name: string;
  createdAt: Date;
  createdById: string | null;
  createdBy: {
    firstName: string;
    lastName: string;
    deletedAt: Date | null;
  } | null;
};

/** One host of the population, with the evidence a classification needs. */
export interface FleetHost {
  id: string;
  label: string;
  kind: SoftwareWatchHost['kind'];
  status: SoftwareWatchHost['status'];
  pending: boolean;
  lastReportedAt: string | null;
  inventoryCollectedAt: string | null;
  /** Does the node store a package list at all? False = software was never/no longer collected. */
  hasSoftware: boolean;
  /** The node's own agent-policy override, parsed read-tolerantly; undefined = none or unreadable. */
  nodePolicy: AgentPolicyOverride | undefined;
}

/** The population plus every matched package, for one or more watched names. */
export interface FleetSnapshot {
  hosts: FleetHost[];
  /** `nodeId` → normalized name → the raw versions the list carries for it. */
  matches: Map<string, Map<string, (string | null)[]>>;
  /** The instance-default policy layer (the only scope above the node the server can resolve here). */
  instancePolicy: AgentPolicyOverride;
}

/** Filters `GET /infra/software-watches/:id/hosts` accepts, already validated by the controller. */
export interface SoftwareWatchHostFilters {
  presence?: SoftwareWatchPresence;
  /** Exact version; `null` selects the "listed without a version" bucket. Implies INSTALLED. */
  version?: string | null;
}

/**
 * SoftwareWatchService — the software watchlist (#1684, split from epic #1146 item 4).
 *
 * The WRITE side is a tiny operator-maintained list (`SoftwareWatch`: a normalized package name,
 * created and soft-deleted, nothing else). The READ side answers each watch with ONE fleet-wide
 * distribution — package name → versions → host counts, plus the hosts MISSING it and the hosts we
 * cannot speak for — computed on read from the package lists agents already store in
 * `InfraNode.specs.software`. Nothing is collected for this, nothing is cached, and nothing travels
 * toward a host.
 *
 * DISTRIBUTION ONLY (CEO decision Q12 on #1146): no version comparison, no "outdated", no EOL flag,
 * no CVE matching. A version is an opaque string that gets counted.
 *
 * MISSING vs UNKNOWN is the load-bearing distinction. MISSING is only ever said about a host whose
 * node STORES a package list that does not name the package. A node storing NO list is UNKNOWN
 * (`NOT_COLLECTED`): that is exactly what software collection being turned off leaves behind — the
 * server clears the stored list on `softwareState: 'disabled'` (#1142) — whichever layer turned it
 * off: the instance default, a service-account override, a node override, or the host's own local
 * veto. Reading the STORED evidence rather than re-resolving the policy is deliberate: a node carries
 * no reporter attribution (#1134), so the service-account layer cannot be resolved per node on a
 * read, and the local veto is invisible to the server by design. A host whose list does not name the
 * package but whose resolvable policy (instance default + node override) EXCLUDES it by glob is also
 * UNKNOWN (`EXCLUDED_BY_POLICY`) — the agent was told not to report it.
 *
 * COST. Every read is one scalar `findMany` over the population plus two raw jsonb projections: one
 * bit + one timestamp per node, and the matching package entries for the watched names only (the
 * filter runs in Postgres, so the ~350 KB per-host package list never crosses the wire). Bounded by
 * {@link SOFTWARE_WATCH_LIMIT} names and the agent-host population, on a page an operator navigates to.
 */
@Injectable()
export class SoftwareWatchService {
  constructor(
    private readonly prisma: PrismaService,
    // The instance-default policy layer, for the EXCLUDED_BY_POLICY check. Same module, stateless.
    private readonly agentPolicy: AgentPolicyService,
  ) {}

  // ── reads ───────────────────────────────────────────────────────────────────

  /** Every live watch, oldest first, each with its distribution — ONE fleet snapshot for all of them. */
  async list(): Promise<SoftwareWatchSummary[]> {
    const rows: WatchRow[] = await this.prisma.softwareWatch.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: WATCH_SELECT,
    });
    if (rows.length === 0) return [];
    const fleet = await this.snapshot(rows.map((row) => row.name));
    return rows.map((row) => ({
      ...flatten(row),
      distribution: summarizeSoftwareWatch(classify(fleet, row.name)),
    }));
  }

  /** One live watch with its distribution. 404 for an unknown or soft-deleted id. */
  async get(id: string): Promise<SoftwareWatchSummary> {
    const row = await this.findLive(id);
    const fleet = await this.snapshot([row.name]);
    return {
      ...flatten(row),
      distribution: summarizeSoftwareWatch(classify(fleet, row.name)),
    };
  }

  /**
   * The paged host list behind one watch — filtered by presence and/or one version bucket, in label
   * order. The population is classified in memory (it is the agent-host count, a few hundred at most)
   * and the window sliced from it, so `total` is always the count of what the filters asked for.
   */
  async listHosts(
    id: string,
    filters: SoftwareWatchHostFilters,
    page: PageQuery,
  ): Promise<Page<SoftwareWatchHost>> {
    const row = await this.findLive(id);
    const fleet = await this.snapshot([row.name]);
    let hosts = classify(fleet, row.name);
    if (filters.presence !== undefined) {
      hosts = hosts.filter((host) => host.presence === filters.presence);
    }
    if (filters.version !== undefined) {
      const wanted = filters.version;
      hosts = hosts.filter(
        (host) =>
          host.presence === 'INSTALLED' && host.versions.includes(wanted),
      );
    }
    return pageOf(
      hosts.slice(page.offset, page.offset + page.limit),
      hosts.length,
      page,
    );
  }

  // ── writes (infra:manage, human-only — enforced at the controller) ──────────

  /**
   * Add a watch. The name arrives already normalized by `CreateSoftwareWatchSchema`. 409 when a LIVE
   * watch already holds that normalized name (the partial unique index is the race-safe backstop —
   * P2002 → 409 via the global filter); 400 once the list holds {@link SOFTWARE_WATCH_LIMIT}.
   */
  async create(
    dto: CreateSoftwareWatch,
    principal?: Principal,
  ): Promise<SoftwareWatch> {
    // Re-normalize defensively: the schema already did, and this is idempotent, so a caller that
    // reached here some other way can still not store a second spelling of one name.
    const name = normalizeSoftwareName(dto.name);
    const clash = await this.prisma.softwareWatch.findFirst({
      where: { name },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(`"${name}" is already on the watchlist`);
    }
    const live = await this.prisma.softwareWatch.count();
    if (live >= SOFTWARE_WATCH_LIMIT) {
      throw new BadRequestException(
        `The watchlist holds at most ${SOFTWARE_WATCH_LIMIT} packages — remove one before adding another.`,
      );
    }
    const row: WatchRow = await this.prisma.softwareWatch.create({
      data: {
        name,
        // The route is HumanOnlyGuard-ed; if a non-human ever reached here the watch is stored
        // unattributed rather than under a fabricated user id.
        createdById: isHumanPrincipal(principal) ? principal.user.id : null,
      },
      select: WATCH_SELECT,
    });
    return flatten(row);
  }

  /** Soft-delete a watch (ADR-0006). Its name is free again for a new watch; the row is kept. */
  async remove(id: string): Promise<SoftwareWatch> {
    await this.findLive(id);
    const row: WatchRow = await this.prisma.softwareWatch.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: WATCH_SELECT,
    });
    return flatten(row);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async findLive(id: string): Promise<WatchRow> {
    // `findFirst` is soft-delete-scoped by the read extension: a deleted watch is a 404.
    const row: WatchRow | null = await this.prisma.softwareWatch.findFirst({
      where: { id },
      select: WATCH_SELECT,
    });
    if (!row) throw new NotFoundException('Software watch not found');
    return row;
  }

  /**
   * Load the population and the evidence for the given watched names in three reads.
   *
   * The two raw projections only ever answer about ids the soft-delete-scoped `findMany` already
   * returned, so a hand-written `WHERE` cannot widen which nodes are visible (the fleet view's rule).
   * Every id and name is a bound parameter via `Prisma.join`; nothing is concatenated.
   */
  private async snapshot(names: readonly string[]): Promise<FleetSnapshot> {
    const nodes = await this.prisma.infraNode.findMany({
      where: SOFTWARE_WATCH_POPULATION_WHERE,
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        label: true,
        kind: true,
        status: true,
        state: true,
        lastReportedAt: true,
        // The node's own policy override — small, and the narrowest layer (#1140).
        agentPolicy: true,
        // NOTE: `specs` is deliberately absent — the evidence comes out of the projections below.
      },
    });
    const instancePolicy = (await this.agentPolicy.getSettings()).settings;
    const matches = new Map<string, Map<string, (string | null)[]>>();
    if (nodes.length === 0) return { hosts: [], matches, instancePolicy };

    const ids = nodes.map((node) => node.id);
    const evidence = await this.prisma.$queryRaw<
      Array<{
        id: string;
        hasSoftware: boolean | null;
        collectedAt: string | null;
      }>
    >(
      // `->` / `->>` are total on a non-object jsonb (a hand-edited scalar blob yields NULL, not an
      // error), so a malformed row degrades to "no list" — UNKNOWN, never a 500 and never MISSING.
      Prisma.sql`SELECT "id",
                        jsonb_typeof("specs"->'software') = 'array' AS "hasSoftware",
                        "specs"->>'reportedAt'                       AS "collectedAt"
                   FROM "infra_nodes"
                  WHERE "id" IN (${Prisma.join(ids)})`,
    );

    const wanted = new Set(names);
    if (wanted.size > 0) {
      const rows = await this.prisma.$queryRaw<
        Array<{ nodeId: string; name: string | null; version: string | null }>
      >(
        // The package filter runs HERE so a host's whole list never leaves Postgres. The CASE keeps
        // `jsonb_array_elements` from raising on a non-array value; the SQL spelling of
        // `normalizeSoftwareName` is re-checked in TypeScript below, so it may only ever NARROW.
        Prisma.sql`SELECT n."id"                AS "nodeId",
                          e->>'name'            AS "name",
                          e->>'version'         AS "version"
                     FROM "infra_nodes" n
               CROSS JOIN LATERAL jsonb_array_elements(
                            CASE WHEN jsonb_typeof(n."specs"->'software') = 'array'
                                 THEN n."specs"->'software'
                                 ELSE '[]'::jsonb END) AS e
                    WHERE n."id" IN (${Prisma.join(ids)})
                      AND jsonb_typeof(e) = 'object'
                      AND lower(btrim(regexp_replace(e->>'name', '[[:space:]]+', ' ', 'g')))
                          IN (${Prisma.join([...wanted])})`,
      );
      for (const row of rows) {
        if (typeof row.name !== 'string') continue;
        const name = normalizeSoftwareName(row.name);
        if (!wanted.has(name)) continue;
        let byName = matches.get(row.nodeId);
        if (!byName) {
          byName = new Map();
          matches.set(row.nodeId, byName);
        }
        const versions = byName.get(name) ?? [];
        versions.push(
          typeof row.version === 'string' && row.version !== ''
            ? row.version
            : null,
        );
        byName.set(name, versions);
      }
    }

    const byId = new Map(evidence.map((row) => [row.id, row]));
    const hosts: FleetHost[] = nodes.map((node) => {
      const facts = byId.get(node.id);
      return {
        id: node.id,
        label: node.label,
        kind: node.kind,
        status: node.status,
        pending: node.state === 'PENDING',
        lastReportedAt: node.lastReportedAt?.toISOString() ?? null,
        inventoryCollectedAt: parseTimestamp(facts?.collectedAt ?? null),
        hasSoftware: facts?.hasSoftware === true,
        nodePolicy: parseOverride(node.agentPolicy),
      };
    });
    return { hosts, matches, instancePolicy };
  }
}

// ── module-local helpers (pure) ───────────────────────────────────────────────

/**
 * Classify every host of the population for ONE watched (normalized) name. Exported for the spec.
 *
 * INSTALLED beats everything: a list that names the package is evidence, whatever the policy says
 * now (a just-applied exclusion only takes effect on the host's next report). Then, for a host whose
 * list does not name it: no list at all → UNKNOWN/NOT_COLLECTED; excluded by a resolvable policy
 * glob → UNKNOWN/EXCLUDED_BY_POLICY; otherwise MISSING.
 */
export function classify(
  fleet: FleetSnapshot,
  name: string,
): SoftwareWatchHost[] {
  return fleet.hosts.map((host) => {
    const base = {
      id: host.id,
      label: host.label,
      kind: host.kind,
      status: host.status,
      pending: host.pending,
      lastReportedAt: host.lastReportedAt,
      inventoryCollectedAt: host.inventoryCollectedAt,
    };
    const raw = fleet.matches.get(host.id)?.get(name);
    if (raw && raw.length > 0) {
      const versions = [...new Set(raw)].sort(compareVersionText);
      return {
        ...base,
        presence: 'INSTALLED',
        versions,
        unknownReason: null,
      };
    }
    if (!host.hasSoftware) {
      return {
        ...base,
        presence: 'UNKNOWN',
        versions: [],
        unknownReason: 'NOT_COLLECTED',
      };
    }
    // The policy layers the server CAN resolve for this node: instance default < node override. The
    // service-account layer in between is not attributable to a node (#1134), and lists REPLACE
    // wholesale per scope, so this is the best available reading — it can only turn a would-be
    // MISSING into UNKNOWN, never invent an INSTALLED.
    const { exclude } = resolveAgentPolicy(0, [
      fleet.instancePolicy,
      host.nodePolicy,
    ]);
    if (matchesAnyGlob(exclude.softwareNames, name)) {
      return {
        ...base,
        presence: 'UNKNOWN',
        versions: [],
        unknownReason: 'EXCLUDED_BY_POLICY',
      };
    }
    return { ...base, presence: 'MISSING', versions: [], unknownReason: null };
  });
}

function flatten(row: WatchRow): SoftwareWatch {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByName:
      row.createdBy && row.createdBy.deletedAt === null
        ? `${row.createdBy.firstName} ${row.createdBy.lastName}`
        : null,
  };
}

/** A node override as the read path sees it — read-TOLERANT: unparseable = no override (#1140). */
function parseOverride(stored: unknown): AgentPolicyOverride | undefined {
  if (stored === null || stored === undefined) return undefined;
  const parsed = AgentPolicyOverrideSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/** The blob's `reportedAt`, re-serialized; anything that is not a date reads as null. */
function parseTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
