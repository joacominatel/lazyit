import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentPolicyOverrideSchema,
  resolveAgentPolicy,
  type AgentPolicy,
  type AgentPolicyOverride,
  type AgentPolicySettings,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isServicePrincipal, type Principal } from '../auth/principal';

/** The singleton row's fixed id — the value the migration's CHECK constraint pins (ADR-0079 pattern). */
const SINGLETON_ID = 'singleton';

/** Re-exported so the controller's DTO and every return type name the same wire shape. */
export type AgentPolicySettingsState = AgentPolicySettings;

/**
 * Server-driven agent policy (ADR-0074 §7 amendment, issue #1140) — resolution and the three write
 * scopes, kept OUT of `InfraService` because it is configuration, not ingestion.
 *
 * WHAT IT DOES NOT DO, stated first because it is the point. Nothing here can send a command, a
 * script, a path or a regular expression to an agent. `AgentPolicyOverrideSchema` is a `strictObject`
 * at every depth over booleans, integers and glob strings, and it is applied on the WRITE path (here)
 * as well as on the wire — so a closed set stays closed even against a hand-edited row, because the
 * read path (see {@link parseOverride}) discards anything that does not re-validate.
 *
 * READ-TOLERANT, WRITE-STRICT (the standing upgrade-safety rule). A stored blob that fails to parse
 * resolves as "this scope adds no override" and is logged — never an exception. The alternative would
 * let one bad config row 500 the report endpoint, i.e. make every host in the estate vanish from the
 * CMDB, which is the failure class ADR-0074's degrade-never-reject posture exists to prevent.
 *
 * THE REVISION IS INSTANCE-WIDE, NOT PER SCOPE. Any write at any scope bumps one counter. The honest
 * consequence: editing ONE node's override bumps the number every OTHER node is compared against, so
 * the whole fleet reads as "pending" until each host next checks in. That is a deliberate trade — the
 * alternative (a revision per resolved policy, e.g. a hash) would make "pending" precise but would
 * stop being an ORDERED value, and an operator asking "is the fleet on the latest config?" is served
 * far better by one number that only ever goes up.
 */
@Injectable()
export class AgentPolicyService {
  private readonly logger = new Logger(AgentPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse ONE stored scope. Anything that does not satisfy the closed schema — legacy shapes, a
   * hand-edited row, a field a NEWER instance wrote before an operator rolled back — degrades to
   * `undefined`, i.e. "adds no override". Deliberately silent about the VALUE it rejected: the blob
   * is operator data and this line ends up in a log an operator reads.
   */
  private parseOverride(
    stored: unknown,
    scope: string,
  ): AgentPolicyOverride | undefined {
    if (stored === null || stored === undefined) return undefined;
    const parsed = AgentPolicyOverrideSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `Ignoring an unreadable agent-policy override at scope ${scope} — this build could not parse it, ` +
        `so that scope contributes nothing and the remaining layers still resolve. Re-save it from the UI to fix it.`,
    );
    return undefined;
  }

  /**
   * The singleton settings row, CREATED on first touch so no seed/migration data is required (the
   * `AssetTagScheme`/`SmtpSettings` self-heal precedent). Reading is the hot path — once per report —
   * so it does a plain `findUnique` first and only upserts when the row is genuinely absent.
   */
  private async readSettingsRow(): Promise<{
    revision: number;
    settings: unknown;
  }> {
    const row = await this.prisma.agentPolicySettings.findUnique({
      where: { id: SINGLETON_ID },
      select: { revision: true, settings: true },
    });
    if (row) return row;
    return this.prisma.agentPolicySettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
      select: { revision: true, settings: true },
    });
  }

  /**
   * The instance-default layer + the current revision + that layer RESOLVED, for the settings UI.
   *
   * `effective` is the instance default alone. A host that also carries a service-account or node
   * override gets something narrower, and the UI is required to say so where it renders this — the
   * whole feature is worthless if an operator reads a screen that is confidently wrong about what a
   * given host is running.
   */
  async getSettings(): Promise<AgentPolicySettingsState> {
    const row = await this.readSettingsRow();
    const settings = this.parseOverride(row.settings, 'instance') ?? {};
    return {
      revision: row.revision,
      settings,
      effective: resolveAgentPolicy(row.revision, [settings]),
    };
  }

  /**
   * Resolve the policy for ONE reporting agent: instance default < its service account < its node.
   *
   * `nodeOverride` is passed in rather than read here because the caller (`ingestReport`) has already
   * resolved the node row — re-reading it would add a query to the hot path for nothing. `principal`
   * supplies the middle layer: a service principal contributes its `agentPolicy`, and a human caller
   * (a role that happens to hold `infra:report`) simply contributes no middle layer at all.
   */
  async resolveForReport(
    principal: Principal | undefined,
    nodeOverride: unknown,
  ): Promise<AgentPolicy> {
    const row = await this.readSettingsRow();
    const account = isServicePrincipal(principal)
      ? // The guard resolves the whole ServiceAccount row, so its override is already in memory —
        // this reads a column that is already loaded, not a second query.
        this.parseOverride(
          (principal.serviceAccount as { agentPolicy?: unknown }).agentPolicy,
          `service-account:${principal.serviceAccount.id}`,
        )
      : undefined;
    return resolveAgentPolicy(row.revision, [
      this.parseOverride(row.settings, 'instance'),
      account,
      this.parseOverride(nodeOverride, 'node'),
    ]);
  }

  /**
   * Validate an override on the WRITE path. A 400 rather than a silent drop, because here the caller
   * is a human in a form and the honest answer to "you typed a regex" is to say so.
   */
  private validate(override: unknown): AgentPolicyOverride {
    const parsed = AgentPolicyOverrideSchema.safeParse(override ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid agent policy — ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      );
    }
    return parsed.data;
  }

  /**
   * Bump the instance-wide revision. Called after EVERY policy write at every scope, so an agent's
   * echoed `policyRevision` is a meaningful answer to "has this host picked up the current config?".
   * `increment` rather than read-then-write: two concurrent admin saves must not collapse into one
   * generation, which would leave a fleet permanently reporting a revision that looks current.
   */
  private async bumpRevision(): Promise<number> {
    // The row may not exist yet (an operator whose first-ever policy action is a node override).
    await this.readSettingsRow();
    const row = await this.prisma.agentPolicySettings.update({
      where: { id: SINGLETON_ID },
      data: { revision: { increment: 1 } },
      select: { revision: true, settings: true },
    });
    return row.revision;
  }

  /**
   * Replace the INSTANCE DEFAULT layer. `{}` means "every built-in default stands".
   *
   * ONE statement writes the layer and bumps the counter, so no window exists in which a resolved
   * policy carries the new settings under the old revision — an agent that read that pair would echo
   * a revision it never actually applied, which is precisely the lie the acknowledgement exists to
   * make impossible.
   */
  async setInstanceOverride(
    override: unknown,
  ): Promise<AgentPolicySettingsState> {
    const settings = this.validate(override);
    await this.readSettingsRow();
    const row = await this.prisma.agentPolicySettings.update({
      where: { id: SINGLETON_ID },
      data: {
        settings: settings,
        revision: { increment: 1 },
      },
      select: { revision: true },
    });
    return {
      revision: row.revision,
      settings,
      effective: resolveAgentPolicy(row.revision, [settings]),
    };
  }

  /**
   * Set (or CLEAR, with `null`) the per-service-account layer — the scope that can configure a host
   * whose node does not exist yet, since the "Add a server" wizard mints one SA per agent.
   *
   * Scoped to LIVE accounts: the soft-delete extension filters `findFirst`, so writing a policy onto
   * a revoked account 404s rather than storing config nothing will ever resolve.
   */
  async setServiceAccountOverride(
    serviceAccountId: string,
    override: unknown,
  ): Promise<AgentPolicySettingsState> {
    const value = override === null ? null : this.validate(override);
    const account = await this.prisma.serviceAccount.findFirst({
      where: { id: serviceAccountId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Service account not found');
    await this.prisma.serviceAccount.update({
      where: { id: serviceAccountId },
      data: {
        agentPolicy:
          value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue),
      },
    });
    const revision = await this.bumpRevision();
    return this.stateForScope(revision, value);
  }

  /** Set (or CLEAR, with `null`) the per-node layer — the narrowest scope, and the post-confirm one. */
  async setNodeOverride(
    nodeId: string,
    override: unknown,
  ): Promise<AgentPolicySettingsState> {
    const value = override === null ? null : this.validate(override);
    const node = await this.prisma.infraNode.findFirst({
      where: { id: nodeId },
      select: { id: true },
    });
    if (!node) throw new NotFoundException('Node not found');
    await this.prisma.infraNode.update({
      where: { id: nodeId },
      data: {
        agentPolicy:
          value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue),
      },
    });
    const revision = await this.bumpRevision();
    return this.stateForScope(revision, value);
  }

  /**
   * The write response for a NARROWER scope: its own stored layer, plus that layer resolved on top of
   * the instance default.
   *
   * `effective` here deliberately omits the layers between: a NODE's effective value does not include
   * its reporting service account's override, because the server does not know which account will
   * report that node until one does. Callers rendering this must not present it as "what this host
   * runs" — it is "what this scope contributes on top of the instance default", and the UI copy says
   * exactly that.
   */
  private async stateForScope(
    revision: number,
    layer: AgentPolicyOverride | null,
  ): Promise<AgentPolicySettingsState> {
    const row = await this.readSettingsRow();
    const instance = this.parseOverride(row.settings, 'instance');
    return {
      revision,
      settings: layer ?? {},
      effective: resolveAgentPolicy(revision, [instance, layer]),
    };
  }
}
