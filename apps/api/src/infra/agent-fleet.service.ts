import { Injectable } from '@nestjs/common';
import {
  AGENT_FLEET_IDENTITY_LIMIT,
  AgentChassisSchema,
  AgentOsFamilySchema,
  agentVersionBucket,
  isAgentDegraded,
  summarizeAgentFleet,
  type AgentFleetDiagnostics,
  type AgentFleetIdentity,
  type AgentFleetNode,
  type AgentFleetView,
  type AgentOsFamily,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The permission an agent's service account holds (ADR-0074 §8). Used here ONLY to recognise which
 * credentials are agent identities — this service grants nothing and authorises nothing.
 */
const AGENT_REPORT_PERMISSION = 'infra:report';

/**
 * AgentFleetService — the assisted-update READ (ADR-0094 §4, issue #1206). It absorbs epic #1146
 * item 1 ("agent fleet view"): *how many agents do I have, on what versions, who has not checked in,
 * and who is degraded?*
 *
 * IT IS A READ AND NOTHING ELSE. No write, no migration, no schema change, no contract change, and
 * emphatically nothing that travels toward a host: ADR-0094 chose assisted update precisely so the
 * server never pushes an instruction a root process acts on ([[0074-server-reporting-agent]] §7). The
 * per-host install command is built in the browser from `osFamily` + the browser's own origin; this
 * service's entire contribution to it is projecting that one string.
 *
 * Three things it deliberately does NOT do:
 *
 *  - **It does not define "behind".** `agentVersionBucket` in `@lazyit/shared` is a pure
 *    re-expression of `isNewerVersion`/`isMajorBehind`, fail-soft posture and all. This service
 *    supplies the two version strings and nothing more.
 *  - **It does not touch `listNodes`.** `GET /infra/nodes` is polled every 5–40s by the review tray
 *    and the wizard, which is why #1135 took `specs` off it; adding a jsonb projection there would
 *    walk that back for a surface that never renders it. The `specs` projection lives HERE, on a read
 *    an admin navigates to.
 *  - **It does not count container children.** A CONTAINER node is stamped with its HOST's
 *    `agentVersion` on every report (it runs no agent of its own, #1139), so counting one would
 *    inflate every bucket by however many containers a host happens to run.
 */
@Injectable()
export class AgentFleetService {
  /**
   * The instance's running build (ADR-0083, baked at image build). Every bucket is computed against
   * it. `dev` on a native run — and, until #1203, on every Docker-served binary — which fails soft to
   * a fleet that is entirely "version unknown". That is the honest answer, and ADR-0094 §2 says so
   * rather than inventing a fallback.
   */
  private readonly serverVersion = process.env.APP_VERSION || 'dev';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The whole fleet view in one read (`GET /infra/agents/fleet`).
   *
   * Two queries plus one credential read, deliberately:
   *
   *  1. An explicit `select` of the scalar columns the wire shape promises — `specs` stays out, as it
   *     does on every list projection (#1135).
   *  2. ONE jsonb projection over the same ids that pulls exactly two things out of `specs`: the OS
   *     family (ADR-0094 §5 / the ADR-0090 display-only computed-read-field mold) and the collector
   *     diagnostics. Two small values, never the blob.
   *
   * Splitting it that way keeps the soft-delete extension in charge of WHICH nodes are visible — the
   * raw projection only ever answers about ids the extension-scoped `findMany` already returned, so a
   * soft-deleted node cannot leak through a hand-written `WHERE`.
   *
   * Read-tolerant end to end: a node with no `agentVersion`, no `specs`, no `specs.host.os.family`, a
   * hand-edited scalar blob, or no report in months all resolve to a row rather than an error.
   */
  async getFleet(): Promise<AgentFleetView> {
    const rows = await this.prisma.infraNode.findMany({
      where: {
        // An agent-bearing HOST: discovered by the agent, and not one of its container children.
        source: 'AGENT',
        kind: { not: 'CONTAINER' },
      },
      orderBy: { label: 'asc' },
      select: {
        id: true,
        label: true,
        kind: true,
        status: true,
        state: true,
        ipAddress: true,
        agentVersion: true,
        chassis: true,
        reportingSource: true,
        lastReportedAt: true,
        // Gated in app code on the asset being live: a to-one relation cannot be `where`-filtered, and
        // a soft-deleted (detached/archived) Asset must never leak its name — the same rule
        // `listNodes` follows.
        asset: { select: { name: true, deletedAt: true } },
        // NOTE: `specs` is deliberately absent — the two values this view needs come out of the
        // narrow jsonb projection below, never the whole blob.
      },
    });

    const projected = await this.projectSpecs(rows.map((row) => row.id));

    const nodes: AgentFleetNode[] = rows.map((row) => {
      const specs = projected.get(row.id);
      const diagnostics = specs?.diagnostics ?? null;
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        status: row.status,
        pending: row.state === 'PENDING',
        assetName:
          row.asset && row.asset.deletedAt === null ? row.asset.name : null,
        ipAddress: row.ipAddress,
        agentVersion: row.agentVersion,
        versionBucket: agentVersionBucket(row.agentVersion, this.serverVersion),
        osFamily: specs?.osFamily ?? null,
        chassis: parseChassis(row.chassis),
        reportingSource: row.reportingSource,
        lastReportedAt: row.lastReportedAt?.toISOString() ?? null,
        diagnostics,
        degraded: isAgentDegraded(diagnostics),
      };
    });

    const identities = await this.listAgentIdentities();

    return {
      serverVersion: this.serverVersion,
      summary: summarizeAgentFleet(nodes),
      nodes,
      identities,
      identitiesNeverUsed: identities.filter((i) => i.lastUsedAt === null)
        .length,
    };
  }

  /**
   * How many agents are at least one MAJOR behind the running instance — the ONE aggregate figure the
   * existing `update.available` email carries (ADR-0094 §Decisions resolved, decision 1). MAJOR-only,
   * because that is the tier ADR-0083/#907 lets speak; an email is an interruption, and a PATCH gap is
   * not worth one.
   *
   * `count`-shaped rather than reusing {@link getFleet}: the mail path wants a number, not a table,
   * and it must not carry a jsonb projection or a credential read into a sweeper. Fail-soft is
   * inherited from `agentVersionBucket` — a fleet reporting `dev` counts zero, so the email simply
   * gains no line.
   */
  async countAgentsMajorBehind(): Promise<number> {
    const rows = await this.prisma.infraNode.findMany({
      where: {
        source: 'AGENT',
        kind: { not: 'CONTAINER' },
        agentVersion: { not: null },
      },
      select: { agentVersion: true },
    });
    return rows.filter(
      (row) =>
        agentVersionBucket(row.agentVersion, this.serverVersion) ===
        'majorBehind',
    ).length;
  }

  // ── the jsonb projection (ADR-0094 §5, the ADR-0090 read-field mold) ────────

  /**
   * Pull `specs.host.os.family` and `specs.diagnostics` out of the stored blob for the given nodes —
   * two small values, never the column.
   *
   * A raw projection because Prisma's `select` cannot address a json PATH: the only way to ask for
   * `specs` through the client is to ask for all of it, and on a real Linux box that is the entire
   * installed-software inventory (~350 KB per row). `->`/`->>` are TOTAL on a non-object jsonb in
   * Postgres (a hand-edited scalar blob yields NULL, it does not raise — unlike the `-` delete
   * operator, which is why {@link InfraService.storedNodeSpecs} guards with `jsonb_typeof` and this
   * does not need to), so a malformed row degrades to "no signal" instead of 500-ing the view.
   *
   * `IN (${Prisma.join(ids)})` — the documented Prisma array-binding idiom (verified against the
   * Prisma 7 raw-queries docs), so every id is a bound parameter and none of this string is ever
   * concatenated. The ids are the ones the soft-delete-scoped `findMany` already returned, so this
   * query widens nothing; an empty list short-circuits, which is also what keeps `Prisma.join` from
   * ever emitting an empty `IN ()`.
   *
   * ponytail (ADR-0094 §5): if an estate ever makes this projection the slow part of the read,
   * promote `osFamily` to a real column. Bounded at a few hundred rows today, on a page an admin
   * navigates to; it is not worth a migration until it is.
   */
  private async projectSpecs(
    ids: string[],
  ): Promise<Map<string, ProjectedSpecs>> {
    const out = new Map<string, ProjectedSpecs>();
    if (ids.length === 0) return out;

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; osFamily: string | null; diagnostics: unknown }>
    >(
      Prisma.sql`SELECT "id",
                        "specs"->'host'->'os'->>'family' AS "osFamily",
                        "specs"->'diagnostics'           AS "diagnostics"
                   FROM "infra_nodes"
                  WHERE "id" IN (${Prisma.join(ids)})`,
    );

    for (const row of rows) {
      out.set(row.id, {
        osFamily: parseOsFamily(row.osFamily),
        diagnostics: parseDiagnostics(row.diagnostics),
      });
    }
    return out;
  }

  // ── agent credentials that may never have been used (ADR-0094 §4 liveness) ──

  /**
   * The live service accounts holding `infra:report` — the agent identities.
   *
   * The other half of liveness, and the only place the most common install failure is visible: a
   * token the "Add a server" wizard minted for a host that then never checked in leaves NO node
   * behind, so a node-only view cannot see it. `lastUsedAt: null` is that fact.
   *
   * NEVER-USED FIRST, then oldest first, then capped — this list exists to surface the dead ones, so
   * they must survive the cap. Soft-deleted (revoked) accounts are excluded by the extension;
   * soft-DISABLED ones are kept and flagged, because "the install fails because someone disabled its
   * token" is exactly the answer an operator is looking for. Nothing here carries a token, a hash or
   * even the display prefix.
   */
  private async listAgentIdentities(): Promise<AgentFleetIdentity[]> {
    const rows = await this.prisma.serviceAccount.findMany({
      where: { permissions: { some: { permission: AGENT_REPORT_PERMISSION } } },
      orderBy: [
        { lastUsedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      take: AGENT_FLEET_IDENTITY_LIMIT,
      select: {
        id: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

// ── module-local helpers (pure) ───────────────────────────────────────────────

/** What {@link AgentFleetService.projectSpecs} pulls out of one node's blob. */
interface ProjectedSpecs {
  osFamily: AgentOsFamily | null;
  diagnostics: AgentFleetDiagnostics | null;
}

/**
 * The reported OS family, or `null` when the blob carries nothing usable (a manual node, a pre-v2
 * agent that never sent `os`, a value a future collector invented). VALIDATE-OR-DROP: a family the
 * enum does not know degrades to "unknown", never to a guess — the web shows BOTH install commands
 * for a null family rather than handing a PowerShell line to a Debian box (#1168).
 *
 * Note the deliberate asymmetry with the WIRE schema, which defaults an absent `os.family` to `linux`
 * (`osFamily()` in @lazyit/shared — every pre-v2 collector was Linux-only). That default belongs to
 * ingestion, where a live report is the evidence. On a READ of a blob that may predate the field
 * entirely, "we do not know" is the honest answer, and it costs the operator one extra command
 * variant rather than a wrong one.
 */
function parseOsFamily(value: string | null): AgentOsFamily | null {
  if (value === null) return null;
  const parsed = AgentOsFamilySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The collector diagnostics as the fleet view reads them (#1138), tolerant of every shape a stored
 * blob can legally hold. `privileged` stays TRI-STATE: a missing flag is `null` ("the agent did not
 * say"), never `false` ("it ran unprivileged") — collapsing those two would mark every pre-#1138
 * agent degraded. Non-string warnings are dropped rather than stringified, and a diagnostics value
 * that is not an object at all reads as no diagnostics.
 */
function parseDiagnostics(value: unknown): AgentFleetDiagnostics | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as { privileged?: unknown; warnings?: unknown };
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const privileged =
    typeof raw.privileged === 'boolean' ? raw.privileged : null;
  // Nothing legible in the block ⇒ report no diagnostics rather than an empty shell that reads as
  // "the collector ran clean".
  if (privileged === null && warnings.length === 0) return null;
  return { privileged, warnings };
}

/**
 * The stored chassis string, kept only when it is one the contract knows (ADR-0093). The column is a
 * bare `String?`, so a value written by a future collector must degrade to "no signal" on read — the
 * same `.catch(null)` posture `InfraNodeSchema.chassis` promises the wire.
 */
function parseChassis(value: string | null): AgentFleetNode['chassis'] {
  if (value === null) return null;
  const parsed = AgentChassisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
