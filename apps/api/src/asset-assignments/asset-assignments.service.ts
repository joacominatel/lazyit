import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AcknowledgeAssignment,
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import { isHumanPrincipal, type Principal } from '../auth/principal';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Filters for listing assignments. `activeOnly` defaults to true (set at the controller). */
export interface FindAssignmentsFilters {
  assetId?: string;
  userId?: string;
  activeOnly?: boolean;
  /** When true, inline each assignment's owner (`user`). Used by GET /assets/:id/assignments. */
  includeUser?: boolean;
}

/**
 * The actor comes from the unified PRINCIPAL resolved by JwtAuthGuard (@CurrentPrincipal()) — never the
 * request body (ADR-0024/0038/0048). A human is attributed to `assignedById` / `releasedById`; a service
 * account to `assignedBySaId` / `releasedBySaId` (a DB CHECK enforces at-most-one actor per slot).
 * Opening and releasing also emit `ASSIGNED` / `RELEASED` asset-history events transactionally (ADR-0033).
 */
@Injectable()
export class AssetAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    // Post-commit targeted nudge to the assigner on acknowledgement (ADR-0089 Part B, #1029). Best-effort:
    // NotificationsService.emit never throws to us, so a nudge failure can't roll back the acknowledgement.
    private readonly notifications: NotificationsService,
  ) {}

  /** Assignments, newest first; filter by asset/user and (by default) active only. */
  findAll({
    assetId,
    userId,
    activeOnly = true,
    includeUser = false,
  }: FindAssignmentsFilters) {
    const args: Prisma.AssetAssignmentFindManyArgs = {
      where: {
        ...(assetId ? { assetId } : {}),
        ...(userId ? { userId } : {}),
        ...(activeOnly ? { releasedAt: null } : {}),
      },
      orderBy: { assignedAt: 'desc' },
      // Inline the owner only when asked (other callers keep the lean shape).
      ...(includeUser ? { include: { user: true } } : {}),
    };
    return this.prisma.assetAssignment.findMany(args);
  }

  /** A single assignment by id; throws 404 if missing. (No soft delete — none to filter.) */
  async findOne(id: string) {
    const assignment = await this.prisma.assetAssignment.findUnique({
      where: { id },
    });
    if (!assignment) {
      throw new NotFoundException(`AssetAssignment ${id} not found`);
    }
    return assignment;
  }

  /**
   * Open an assignment (assign a user to an asset). `assetId` and `userId` must reference **live**
   * (non-soft-deleted) rows → 400 otherwise (don't assign a decommissioned asset or a departed user;
   * mirrors AccessGrantsService.create). Rejects a duplicate *active* (asset, user) pair with 409 —
   * a friendly pre-check; the partial unique index is the race-proof backstop (also surfaces as 409
   * via PrismaExceptionFilter). A different user on the same asset is allowed (multi-owner).
   * `assignedById` is set from the authenticated User when present (null = system/unknown).
   */
  async create(data: CreateAssetAssignment, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    await this.assertAssetUsable(data.assetId);
    await this.assertUserUsable(data.userId);
    const existingActive = await this.prisma.assetAssignment.findFirst({
      where: { assetId: data.assetId, userId: data.userId, releasedAt: null },
    });
    if (existingActive) {
      throw new ConflictException(
        'An active assignment already exists for this asset and user',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.assetAssignment.create({
        data: {
          ...data,
          // Attribute the OPEN action: human → assignedById, service account → assignedBySaId. The DB
          // at-most-one-actor CHECK on (assignedById, assignedBySaId) is satisfied because resolveActor
          // returns at most one of the pair (ADR-0048).
          ...(actor.userId != null ? { assignedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { assignedBySaId: actor.serviceAccountId }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: data.assetId,
        eventType: 'ASSIGNED',
        payload: { userId: data.userId },
        actor,
      });
      return assignment;
    });
  }

  /**
   * Release an active assignment: set `releasedAt = now()` (+ `releasedById` from the authenticated
   * User, optional `notes`). 404 if missing; 409 if already released (release is not repeatable).
   * Releasing one owner does not affect any other active assignment on the same asset.
   *
   * The findOne pre-check is a friendly 404/409, not the race guard: two concurrent releases (or a
   * double-click) can both read `releasedAt === null`. The DB backstop is the conditional
   * `updateMany({ where: { id, releasedAt: null } })` — only the winner flips the row (`count === 1`)
   * and records the single RELEASED event; the loser sees `count === 0` and 409s, writing nothing.
   * Mirrors the create path's friendly-pre-check + DB-backstop pattern (there a partial unique index;
   * a unique index can't express "release once", so the conditional write is the right tool). SEC-031.
   */
  async release(
    id: string,
    data: ReleaseAssetAssignment,
    principal?: Principal,
  ) {
    const assignment = await this.findOne(id);
    if (assignment.releasedAt !== null) {
      throw new ConflictException(`AssetAssignment ${id} is already released`);
    }
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.assetAssignment.updateMany({
        // atomic check-and-set: the `releasedAt: null` predicate makes the transition happen at most
        // once even under concurrency, so the history-write below only runs when WE did the release.
        where: { id, releasedAt: null },
        data: {
          releasedAt: new Date(),
          // Attribute the RELEASE action: human → releasedById, service account → releasedBySaId.
          // CHECK-safe by construction (resolveActor returns at most one of the pair; ADR-0048).
          ...(actor.userId != null ? { releasedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { releasedBySaId: actor.serviceAccountId }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      if (count === 0) {
        // lost the race - a concurrent release committed first; same 409 as the pre-check, and we
        // bail before recording history (the throw rolls the tx back), so no duplicate RELEASED row
        throw new ConflictException(
          `AssetAssignment ${id} is already released`,
        );
      }
      await this.history.record(tx, {
        assetId: assignment.assetId,
        eventType: 'RELEASED',
        // Mirror ASSIGNED's {userId}: a multi-owner asset can release one of several owners, so the
        // released owner must be on the RELEASED row to disambiguate the timeline.
        payload: { userId: assignment.userId },
        actor,
      });
      // updateMany returns only a count; re-read the row for the response (identity is immutable)
      return tx.assetAssignment.findUnique({ where: { id } });
    });
  }

  /**
   * Acknowledge receipt of an asset checked out to you (ADR-0089 Part B, #1029). SELF-SERVICE and scoped
   * to the caller's OWN active assignment — no coarse permission; the authorization IS "it's your own
   * active assignment" (the /access-requests/mine self-scope carve-out, ADR-0085). Human-only (the
   * controller's ServicePrincipalForbiddenGuard 403s a service account; {@link requireHumanCaller} is the
   * defence-in-depth backstop).
   *
   * Set-once + race-safe, exactly like {@link release}: the conditional
   * `updateMany({ where: { id, userId: caller, releasedAt: null, acknowledgedAt: null } })` flips the row
   * at most once, so a double-click / concurrent call acknowledges once and records exactly one
   * ACKNOWLEDGED history event. `count === 0` is the SINGLE 409 covering already-acknowledged / released /
   * not-the-caller's (an assignment that isn't the caller's simply matches nothing). On success the
   * ACKNOWLEDGED event is recorded in the SAME transaction; then, best-effort AFTER commit, a targeted
   * nudge tells the human who assigned the device.
   */
  async acknowledge(
    id: string,
    data: AcknowledgeAssignment,
    principal?: Principal,
  ) {
    const caller = this.requireHumanCaller(principal);
    // Friendly pre-check: a clean 404 for a missing id, and it captures the assigner (the nudge
    // recipient) + assetId + userId for the post-commit emit.
    const assignment = await this.findOne(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.assetAssignment.updateMany({
        // atomic set-once + self-scope: ONLY the caller's own still-active, not-yet-acknowledged row flips.
        where: { id, userId: caller, releasedAt: null, acknowledgedAt: null },
        data: {
          acknowledgedAt: new Date(),
          acknowledgedById: caller,
          ...(data.note !== undefined ? { acknowledgeNote: data.note } : {}),
        },
      });
      if (count === 0) {
        // already acknowledged / released / not the caller's assignment — one 409, nothing written (the
        // throw rolls the tx back before any history row is recorded).
        throw new ConflictException(
          `AssetAssignment ${id} cannot be acknowledged (already acknowledged, released, or not yours)`,
        );
      }
      await this.history.record(tx, {
        assetId: assignment.assetId,
        eventType: 'ACKNOWLEDGED',
        // The acknowledging owner (caller === the assignee by the self-scope) — mirrors ASSIGNED/RELEASED.
        payload: { userId: caller },
        actor: { userId: caller },
      });
      // updateMany returns only a count; re-read the row for the response (identity is immutable).
      return tx.assetAssignment.findUnique({ where: { id } });
    });
    // AFTER commit, best-effort: nudge the human who assigned the device that it was acknowledged.
    await this.emitAcknowledgedNotification(assignment);
    return updated;
  }

  /**
   * Release EVERY active assignment owned by `userId`, atomically with the caller's transaction
   * (used by user offboarding — users.service.remove). Mirrors {@link release}: stamps
   * `releasedAt = now()` + `releasedById = actorId` on each open assignment and emits one `RELEASED`
   * asset-history event per asset (ADR-0033) so the audit trail stays complete.
   *
   * Takes the caller's `$transaction` client so the releases, the history rows and the user
   * soft-delete all commit together (or all roll back). No-op (returns []) when the user owns no
   * active assignment. The history client is structurally typed; the tx client satisfies it.
   *
   * @returns the released assignment ids (reclaimed assets), for the offboarding summary.
   */
  async releaseAllForUser(
    tx: Prisma.TransactionClient,
    userId: string,
    actor: ActorAttribution = {},
  ): Promise<{ id: string; assetId: string }[]> {
    const active = await tx.assetAssignment.findMany({
      where: { userId, releasedAt: null },
      select: { id: true, assetId: true },
    });
    const now = new Date();
    for (const assignment of active) {
      await tx.assetAssignment.update({
        where: { id: assignment.id },
        data: {
          releasedAt: now,
          // Attribute the offboarding actor on each release: human → releasedById, SA → releasedBySaId
          // (an SA holding user:manage may run the offboarding). CHECK-safe (ADR-0048).
          ...(actor.userId != null ? { releasedById: actor.userId } : {}),
          ...(actor.serviceAccountId != null
            ? { releasedBySaId: actor.serviceAccountId }
            : {}),
        },
      });
      await this.history.record(tx, {
        assetId: assignment.assetId,
        eventType: 'RELEASED',
        // Stamp the released owner (same as release()): the RELEASED rows are attributable per owner.
        payload: { userId },
        actor,
      });
    }
    return active;
  }

  /**
   * Update only the notes (the one mutable field besides releasedAt; identity is immutable).
   * Allowed even after release; `null` clears the note. 404 if missing.
   */
  async updateNotes(id: string, data: UpdateAssetAssignmentNotes) {
    await this.findOne(id);
    return this.prisma.assetAssignment.update({
      where: { id },
      data: { notes: data.notes },
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Resolve the caller to the HUMAN assignee's `User.id`. Acknowledgement is human-only and self-scoped
   * (the controller's ServicePrincipalForbiddenGuard already 403s a service account); this is
   * defence-in-depth — a missing/non-human principal is a 403, never a null actor.
   */
  private requireHumanCaller(principal?: Principal): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'An authenticated human user is required to acknowledge an assignment.',
      );
    }
    return principal.user.id;
  }

  /**
   * Best-effort POST-COMMIT bell + email nudge to the ASSIGNER that the assignee acknowledged receipt
   * (ADR-0089 Part B, #1029) — a TARGETED notification (`recipientUserId = assignedById`) so it lands in
   * that operator's OWN bell even when they hold no `notification:read`. Only a HUMAN assigner has a bell:
   * a null assigner (system/import) or a service-account assigner (`assignedBySaId` set → `assignedById`
   * null by the at-most-one CHECK) has no recipient, so we return early. Every failure is swallowed (a
   * nudge never affects the committed acknowledgement). INV-6-safe: metadata carries the asset name/tag +
   * the assignee name/ids only — no bodies/secrets.
   */
  private async emitAcknowledgedNotification(assignment: {
    id: string;
    assetId: string;
    userId: string;
    assignedById: string | null;
  }): Promise<void> {
    try {
      if (assignment.assignedById === null) {
        return; // no human assigner to nudge (null / service-account assigner).
      }
      const [asset, assignee] = await Promise.all([
        this.prisma.asset.findUnique({
          where: { id: assignment.assetId },
          select: { name: true, assetTag: true },
        }),
        this.prisma.user.findUnique({
          where: { id: assignment.userId },
          select: { firstName: true, lastName: true },
        }),
      ]);
      if (!asset) {
        return; // asset vanished post-commit — nothing meaningful to nudge about.
      }
      const assetLabel = asset.assetTag
        ? `${asset.name} (${asset.assetTag})`
        : asset.name;
      const assigneeName =
        assignee && (assignee.firstName || assignee.lastName)
          ? `${assignee.firstName} ${assignee.lastName}`.trim()
          : 'The assignee';

      await this.notifications.emit({
        type: 'asset_assignment.acknowledged',
        dedupeKey: `asset_assignment.acknowledged:${assignment.id}`,
        severity: 'info',
        // TARGETED to the assigner: it lands in THEIR bell (even without notification:read).
        recipientUserId: assignment.assignedById,
        title: `${assigneeName} acknowledged ${assetLabel}`,
        summary: `${assigneeName} confirmed they received ${assetLabel}.`,
        entityType: 'asset',
        entityId: assignment.assetId,
        // Who it is ABOUT (the assignee) — a secondary click-through to that person.
        targetUserId: assignment.userId,
        metadata: {
          assetName: asset.name,
          ...(asset.assetTag !== null ? { assetTag: asset.assetTag } : {}),
          assignmentId: assignment.id,
          assigneeId: assignment.userId,
          assigneeName,
        },
      });
    } catch {
      // Best-effort: a failed nudge never affects the already-committed acknowledgement.
    }
  }

  /**
   * 400 if assetId doesn't reference a live (non-soft-deleted) asset. The soft-delete read filter
   * hides deleted assets, so findFirst returns null for them — assigning a decommissioned asset is
   * a client error, not a 500 at the FK. Mirrors AccessGrantsService.assertApplicationUsable.
   */
  private async assertAssetUsable(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) {
      throw new BadRequestException(
        `assetId ${assetId} does not reference a live asset`,
      );
    }
  }

  /**
   * 400 if userId doesn't reference a live (non-soft-deleted) user — don't assign an asset to a
   * departed/offboarded user. Mirrors AccessGrantsService.assertUserUsable.
   */
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
}
