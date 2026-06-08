import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BatchResult,
  CreateAccessGrant,
  PageQuery,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import type { TriggerPlan } from '../workflow-engine/run/workflow-trigger.service';
import type { ActorAttribution } from '../common/actor.service';

/** Filters for listing grants. `activeOnly` / `includeExpired` default to true (set at the controller). */
export interface FindAccessGrantsFilters {
  userId?: string;
  applicationId?: string;
  activeOnly?: boolean;
  includeExpired?: boolean;
}

/**
 * AccessGrant — the User↔Application access join (append-only, revoked via `revokedAt`; ADR-0023).
 * The actor comes from the unified PRINCIPAL resolved by JwtAuthGuard (@CurrentPrincipal()) — never the
 * request body (ADR-0022/0024/0038/0048). A human is attributed to `grantedById` / `revokedById`; a
 * service account to `grantedBySaId` / `revokedBySaId` (a DB CHECK enforces at-most-one actor per slot).
 */
@Injectable()
export class AccessGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly workflowTrigger: WorkflowTriggerService,
  ) {}

  /**
   * Grants, newest first. Filters: user, application, `activeOnly` (only `revokedAt = null`,
   * default true) and `includeExpired` (default true; when false, hides grants already past their
   * `expiresAt`). `expiresAt` never changes activeness — it's informative (ADR-0023).
   *
   * Unpaginated — still used by the inherently-scoped nested lists (`/users/:id/access-grants`,
   * `/applications/:id/access-grants`). The top-level `GET /access-grants` uses {@link findPage}.
   */
  findAll(filters: FindAccessGrantsFilters) {
    return this.prisma.accessGrant.findMany({
      where: this.buildWhere(filters),
      orderBy: { grantedAt: 'desc' },
    });
  }

  /**
   * A single page of grants (newest first) for the top-level `GET /access-grants` — the most
   * sensitive unbounded list (ADR-0030/SEC-007). Runs the page `findMany(take/skip)` and the `count`
   * over the **same** `where` inside one `$transaction`, so the `total` can't drift from the page
   * under concurrent inserts/revokes. Same filters as {@link findAll}.
   */
  async findPage(filters: FindAccessGrantsFilters, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.accessGrant.findMany({
        where,
        orderBy: { grantedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.accessGrant.count({ where }),
    ]);
    // The Prisma rows carry `Date`s; the API serializes them to the ISO-string wire shape at the
    // HTTP boundary (same as findAll/findOne) — the AccessGrantListPage DTO documents that shape.
    return pageOf(items, total, page);
  }

  /** The shared `where` for the grant lists — used identically by findAll, findPage and its count. */
  private buildWhere({
    userId,
    applicationId,
    activeOnly = true,
    includeExpired = true,
  }: FindAccessGrantsFilters): Prisma.AccessGrantWhereInput {
    return {
      ...(userId ? { userId } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(activeOnly ? { revokedAt: null } : {}),
      ...(includeExpired
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
    };
  }

  /** A single grant by id; throws 404 if missing. (No soft delete — none to filter.) */
  async findOne(id: string) {
    const grant = await this.prisma.accessGrant.findUnique({ where: { id } });
    if (!grant) {
      throw new NotFoundException(`AccessGrant ${id} not found`);
    }
    return grant;
  }

  /**
   * Open a grant (give a user access to an application). `userId` and `applicationId` must reference
   * **live** (non-soft-deleted) rows → 400 otherwise (don't grant access to a decommissioned app or
   * a departed user). Multi-grant is allowed: no uniqueness check. `grantedById` is set from the
   * authenticated User when present (null = system/unknown).
   */
  async create(data: CreateAccessGrant, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    await this.assertUserUsable(data.userId);
    await this.assertApplicationUsable(data.applicationId);

    // Engine TRANSACTIONAL OUTBOX (ADR-0054 §1, the INV-5 inverse). The workflow LOOKUP runs BEFORE the
    // write tx and is swallowed on any failure — a broken engine path never blocks or rolls back the
    // grant. If no enabled workflow with a version exists, `plan` is null and we behave EXACTLY as today.
    const plan = await this.planTrigger('ACCESS_GRANTED', data.applicationId);

    const { grant, runId } = await this.prisma.$transaction(async (tx) => {
      const grant = await tx.accessGrant.create({
        data: {
          userId: data.userId,
          applicationId: data.applicationId,
          ...(data.accessLevel !== undefined
            ? { accessLevel: data.accessLevel }
            : {}),
          ...(data.expiresAt !== undefined
            ? { expiresAt: new Date(data.expiresAt) }
            : {}),
          ...(data.grantedAt !== undefined
            ? { grantedAt: new Date(data.grantedAt) }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          // Attribute the GRANT action: human → grantedById, service account → grantedBySaId. CHECK-safe
          // by construction (resolveActor returns at most one of the pair; ADR-0048).
          ...(actor.userId != null ? { grantedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { grantedBySaId: actor.serviceAccountId }
            : {}),
        },
      });
      // The PENDING run row is committed ATOMICALLY with the grant (the outbox). The only in-tx engine
      // write, and one that cannot realistically fail (the idempotency key is unique per fresh grant).
      const runId = plan
        ? (
            await tx.workflowRun.create({
              data: this.workflowTrigger.buildRunData(plan, grant.id, actor),
              select: { id: true },
            })
          ).id
        : null;
      return { grant, runId };
    });

    // AFTER commit: best-effort enqueue. A broker-down enqueue leaves the run PENDING for the sweeper.
    if (runId) {
      await this.enqueueRunSafely(runId);
    }
    return grant;
  }

  /**
   * Revoke an active grant: set `revokedAt = now()` (+ `revokedById` from the authenticated User,
   * optional `notes`). 404 if missing; 409 if already revoked (revoke is not repeatable). Revoking
   * one grant does not affect any other grant the same user holds on the same application.
   */
  async revoke(id: string, data: RevokeAccessGrant, principal?: Principal) {
    const grant = await this.findOne(id);
    if (grant.revokedAt !== null) {
      throw new ConflictException(`AccessGrant ${id} is already revoked`);
    }
    const actor = this.actor.resolveActor(principal);

    // Engine outbox lookup (best-effort, before the tx — never affects the revoke).
    const plan = await this.planTrigger('ACCESS_REVOKED', grant.applicationId);

    const { updated, runId } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.accessGrant.update({
        where: { id },
        data: {
          revokedAt: new Date(),
          // Attribute the REVOKE action: human → revokedById, service account → revokedBySaId. CHECK-safe
          // by construction (ADR-0048).
          ...(actor.userId != null ? { revokedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { revokedBySaId: actor.serviceAccountId }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      const runId = await this.recordRevokeRun(tx, plan, updated, actor);
      return { updated, runId };
    });

    if (runId) {
      await this.enqueueRunSafely(runId);
    }
    return updated;
  }

  /**
   * Update only the notes (a metadata edit, no actor). Allowed even after revoke; `null` clears the
   * note. Identity (user, application, grantedAt) is immutable. 404 if missing.
   */
  async updateNotes(id: string, data: UpdateAccessGrantNotes) {
    await this.findOne(id);
    return this.prisma.accessGrant.update({
      where: { id },
      data: { notes: data.notes },
    });
  }

  /**
   * Change the expiry — extend, shorten or clear it (`null` => permanent). A metadata edit, no actor.
   * `expiresAt` is informative: changing it never revokes or reactivates the grant (ADR-0023). 404
   * if missing.
   */
  async updateExpiry(id: string, data: UpdateAccessGrantExpiry) {
    await this.findOne(id);
    return this.prisma.accessGrant.update({
      where: { id },
      data: {
        expiresAt: data.expiresAt === null ? null : new Date(data.expiresAt),
      },
    });
  }

  /**
   * Bulk revoke (ADMIN, ADR-0030 amendment): revoke a set of active grants in ONE transaction. Each
   * grant is revoked INDIVIDUALLY (its own `revokedAt` / `revokedById` / optional shared `notes`) —
   * auditability stays per-grant, exactly as the single-item {@link revoke} records it, never one
   * entry for the whole batch. An id that is missing or already revoked is SKIPPED (reported in the
   * result), not an error, so a partial multi-select still commits. Returns the per-id outcome.
   */
  async batchRevoke(
    ids: string[],
    notes: string | null | undefined,
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const grants = await this.prisma.accessGrant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        revokedAt: true,
        userId: true,
        applicationId: true,
      },
    });
    const found = new Map(grants.map((g) => [g.id, g]));
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const g = found.get(id);
      if (!g) skipped.push({ id, reason: 'not_found' });
      else if (g.revokedAt !== null)
        skipped.push({ id, reason: 'already_in_state' });
      else succeeded.push(id);
    }

    const runIds: string[] = [];
    if (succeeded.length > 0) {
      // Pre-plan the ACCESS_REVOKED workflow per distinct application (best-effort, before the tx).
      const appIds = [
        ...new Set(succeeded.map((id) => found.get(id)!.applicationId)),
      ];
      const plans = new Map<string, TriggerPlan | null>();
      for (const appId of appIds) {
        plans.set(appId, await this.planTrigger('ACCESS_REVOKED', appId));
      }

      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          const g = found.get(id)!;
          const updated = await tx.accessGrant.update({
            where: { id },
            data: {
              revokedAt: now,
              // Per-grant actor attribution (same as the single-item revoke): human → revokedById,
              // service account → revokedBySaId. CHECK-safe by construction (ADR-0048).
              ...(actor.userId != null ? { revokedById: actor.userId } : {}),
              ...(actor.serviceAccountId != null
                ? { revokedBySaId: actor.serviceAccountId }
                : {}),
              ...(notes !== undefined && notes !== null ? { notes } : {}),
            },
          });
          const runId = await this.recordRevokeRun(
            tx,
            plans.get(g.applicationId) ?? null,
            updated,
            actor,
          );
          if (runId) runIds.push(runId);
        }
      });
    }
    // Post-commit, best-effort enqueue of every fired run (a miss is recovered by the sweeper).
    for (const runId of runIds) {
      await this.enqueueRunSafely(runId);
    }
    return { requested: ids.length, succeeded, skipped };
  }

  // --- engine outbox helpers (the INV-5-inverse decoupling) ----------------

  /**
   * Look up the enabled workflow for (trigger, application) — a READ run OUTSIDE the write tx and
   * SWALLOWED on any failure, so a broken engine path can never block or roll back the grant. Returns
   * the plan (which workflow/version to fire) or null (no workflow → behave exactly as today).
   */
  private planTrigger(
    trigger: 'ACCESS_GRANTED' | 'ACCESS_REVOKED',
    applicationId: string,
  ): Promise<TriggerPlan | null> {
    return this.workflowTrigger
      .planForTrigger(trigger, applicationId)
      .catch(() => null);
  }

  /**
   * Write the PENDING run row for a REVOKE inside the grant tx, applying the deprovision policy: under
   * the default LAST_ACTIVE_GRANT, the workflow fires ONLY when the revoked grant was the user's LAST
   * active grant on the application (so a user who still holds access is never deprovisioned). The count
   * runs INSIDE the tx (after the revoke update) so concurrent revokes can't both miss "last". Returns
   * the created run id, or null when no workflow fires.
   */
  private async recordRevokeRun(
    tx: Prisma.TransactionClient,
    plan: TriggerPlan | null,
    grant: { id: string; userId: string; applicationId: string },
    actor: ActorAttribution,
  ): Promise<string | null> {
    if (!plan) {
      return null;
    }
    const fire =
      plan.deprovisionPolicy === 'EACH_GRANT'
        ? true
        : (await tx.accessGrant.count({
            where: {
              userId: grant.userId,
              applicationId: grant.applicationId,
              revokedAt: null,
            },
          })) === 0;
    if (!fire) {
      return null;
    }
    const run = await tx.workflowRun.create({
      data: this.workflowTrigger.buildRunData(plan, grant.id, actor),
      select: { id: true },
    });
    return run.id;
  }

  /** Post-commit enqueue that never throws (a broker outage leaves the run PENDING for the sweeper). */
  private async enqueueRunSafely(runId: string): Promise<void> {
    try {
      await this.workflowTrigger.enqueue(runId);
    } catch {
      // The trigger already swallows broker errors; this is a final belt-and-braces guard.
    }
  }

  // --- internals -----------------------------------------------------------

  /** 400 if userId doesn't reference a live (non-soft-deleted) user. */
  private async assertUserUsable(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        `userId ${userId} does not reference a live user`,
      );
    }
  }

  /** 400 if applicationId doesn't reference a live (non-soft-deleted) application. */
  private async assertApplicationUsable(applicationId: string): Promise<void> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new BadRequestException(
        `applicationId ${applicationId} does not reference a live application`,
      );
    }
  }
}
