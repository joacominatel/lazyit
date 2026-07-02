import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateAccessRequest,
  DenyAccessRequest,
  PageQuery,
} from '@lazyit/shared';
import { offsetOf, pageOf } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isHumanPrincipal, type Principal } from '../auth/principal';

/** Filters for the estate-wide request list (`GET /access-requests`). */
export interface FindAccessRequestsFilters {
  status?: 'PENDING' | 'APPROVED' | 'DENIED';
  applicationId?: string;
  requesterId?: string;
}

/**
 * AccessRequest — the self-service request → approve/deny → grant flow (ADR-0085), closing the deferral
 * of ADR-0023. A request is a lifecycle row: PENDING until an approver decides it, then APPROVED (a grant
 * is produced) or DENIED (with a reason). Rows are never deleted.
 *
 * Key rules enforced here:
 *   - ONE open request per (requester, application) — a second PENDING create is a 409 (checked up-front
 *     AND backstopped by the partial unique index, which the service maps to 409 on the race).
 *   - APPROVAL creates the AccessGrant + flips the request to APPROVED in ONE transaction, through the
 *     EXISTING grant write path ({@link AccessGrantsService.createWithinApproval}) so provisioning +
 *     audit attribution (ADR-0054/0048) keep working, and the two writes are atomic.
 *   - DENY records a required reason.
 *   - Deciding is HUMAN-only (there is no service-account decider column) and requires `accessGrant:grant`
 *     (gated at the controller — no new decide permission, YAGNI).
 */
@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: AccessGrantsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Raise a request (`POST /access-requests`). `requesterId` is the authenticated human (never the body).
   * The application must be live (→ 400). At most one OPEN (PENDING) request per (requester, application):
   * a second is 409 — checked up-front for a clean message and enforced by the partial unique index for
   * the race (mapped to the same 409). Fires the `access_request.created` bell nudge AFTER commit.
   */
  async create(requesterId: string, data: CreateAccessRequest) {
    await this.assertApplicationUsable(data.applicationId);

    const existing = await this.prisma.accessRequest.findFirst({
      where: {
        requesterId,
        applicationId: data.applicationId,
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'You already have a pending access request for this application.',
      );
    }

    let request;
    try {
      request = await this.prisma.accessRequest.create({
        data: {
          requesterId,
          applicationId: data.applicationId,
          ...(data.accessLevel !== undefined
            ? { accessLevel: data.accessLevel }
            : {}),
          ...(data.justification !== undefined
            ? { justification: data.justification }
            : {}),
        },
      });
    } catch (err) {
      // The partial unique index (WHERE status = 'PENDING') is the race backstop: two concurrent creates
      // for the same (requester, application) → the loser hits P2002 → the same friendly 409.
      if (this.isPendingUniqueViolation(err)) {
        throw new ConflictException(
          'You already have a pending access request for this application.',
        );
      }
      throw err;
    }

    // AFTER commit, best-effort: nudge the admins who can decide (ADR-0085 / ADR-0056 §3).
    await this.emitCreatedNotification(request);
    return request;
  }

  /**
   * A single page of requests (newest-first) for the estate-wide `GET /access-requests` — gated by
   * `accessRequest:read` at the controller. Runs the page + count over the SAME `where` in one
   * transaction so the total can't drift under concurrent inserts/decisions.
   */
  async findPage(filters: FindAccessRequestsFilters, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.accessRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.accessRequest.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /**
   * The caller's OWN requests (`GET /access-requests/mine`) — the self-scope carve-out (ADR-0085): any
   * authenticated human sees their own requests, PENDING and decided, regardless of `accessRequest:read`.
   * Scoped strictly to `requesterId == caller` so it can never leak another user's requests.
   */
  findMine(requesterId: string, page: PageQuery) {
    return this.findPage({ requesterId }, page);
  }

  /** The shared `where` for the request lists. */
  private buildWhere({
    status,
    applicationId,
    requesterId,
  }: FindAccessRequestsFilters): Prisma.AccessRequestWhereInput {
    return {
      ...(status ? { status } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(requesterId ? { requesterId } : {}),
    };
  }

  /**
   * APPROVE a request (`POST /access-requests/:id/approve`) — creates the AccessGrant AND flips the
   * request to APPROVED in ONE transaction (ADR-0085). Reuses the existing grant write path so the
   * workflow engine fires AFTER commit and the grant is audited/attributed to the approver. 404 if
   * missing; 409 if already decided. Deciding is human-only (the approver fills `decidedById`).
   */
  async approve(id: string, principal?: Principal) {
    const decider = this.requireHumanDecider(principal);
    const request = await this.findPending(id);

    await this.grants.createWithinApproval(
      {
        userId: request.requesterId,
        applicationId: request.applicationId,
        ...(request.accessLevel !== null
          ? { accessLevel: request.accessLevel }
          : {}),
      },
      principal,
      async (tx, createdGrant) => {
        // Fold the request-close into the grant's tx so the two are atomic. A guarded update: only a
        // still-PENDING row flips (so a lost race — another approver decided first — updates 0 rows and
        // we detect it below), preventing a double-approve producing two grants.
        const flipped = await tx.accessRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            decidedById: decider,
            decidedAt: new Date(),
            grantId: createdGrant.id,
          },
        });
        if (flipped.count === 0) {
          // Rolls back the just-created grant — the request was decided concurrently.
          throw new ConflictException(
            `AccessRequest ${id} has already been decided`,
          );
        }
      },
    );

    // The grant is created and the request flipped to APPROVED atomically; return the updated request
    // (now carrying grantId + decision fields).
    return this.findOne(id);
  }

  /**
   * DENY a request (`POST /access-requests/:id/deny`) — records a REQUIRED reason. 404 if missing; 409 if
   * already decided. Human-only (the decider fills `decidedById`). No grant is produced.
   */
  async deny(id: string, data: DenyAccessRequest, principal?: Principal) {
    const decider = this.requireHumanDecider(principal);
    await this.findPending(id);

    const flipped = await this.prisma.accessRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'DENIED',
        decidedById: decider,
        decidedAt: new Date(),
        deniedReason: data.reason,
      },
    });
    if (flipped.count === 0) {
      // Concurrent decision won the race between findPending and the guarded update.
      throw new ConflictException(
        `AccessRequest ${id} has already been decided`,
      );
    }
    return this.findOne(id);
  }

  // --- internals -----------------------------------------------------------

  /** A single request by id; 404 if missing. (No soft delete — none to filter.) */
  private async findOne(id: string) {
    const request = await this.prisma.accessRequest.findUnique({
      where: { id },
    });
    if (!request) {
      throw new NotFoundException(`AccessRequest ${id} not found`);
    }
    return request;
  }

  /** Load a request and assert it is still PENDING (→ 404 if missing, 409 if already decided). */
  private async findPending(id: string) {
    const request = await this.findOne(id);
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        `AccessRequest ${id} has already been decided`,
      );
    }
    return request;
  }

  /**
   * Resolve the caller to the HUMAN decider's `User.id`. Deciding is human-only (there is no SA decider
   * column); the controller already 403s a service account, so this is defence-in-depth (a
   * missing/non-human principal → 403 rather than a null decider).
   */
  private requireHumanDecider(principal?: Principal): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'An authenticated human user is required to decide an access request.',
      );
    }
    return principal.user.id;
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

  /** True when the error is the partial-unique (one-PENDING-per-pair) violation. */
  private isPendingUniqueViolation(err: unknown): boolean {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const target = err.meta?.target;
      const name = Array.isArray(target) ? target.join(',') : String(target);
      return name.includes('pending');
    }
    return false;
  }

  /**
   * Best-effort POST-COMMIT bell nudge for a newly-raised request (ADR-0085 / ADR-0056 §3) — a BROADCAST
   * to the admin feed (the holders of `notification:read`, which by default is the ADMIN cohort that also
   * holds `accessGrant:grant` and can decide). Every failure is swallowed (a nudge never affects the
   * committed request). INV-6-safe: metadata carries names/ids only.
   */
  private async emitCreatedNotification(request: {
    id: string;
    requesterId: string;
    applicationId: string;
    accessLevel: string | null;
  }): Promise<void> {
    try {
      const [application, user] = await Promise.all([
        this.prisma.application.findUnique({
          where: { id: request.applicationId },
          select: { name: true },
        }),
        this.prisma.user.findUnique({
          where: { id: request.requesterId },
          select: { firstName: true, lastName: true },
        }),
      ]);
      if (!application) {
        return; // app vanished post-commit — nothing meaningful to nudge about.
      }
      const userName = user
        ? `${user.firstName} ${user.lastName}`.trim()
        : 'A user';

      await this.notifications.emit({
        type: 'access_request.created',
        dedupeKey: `access_request.created:${request.id}`,
        severity: 'info',
        title: `${userName} requested access to ${application.name}`,
        summary: request.accessLevel
          ? `Requested level: ${request.accessLevel}.`
          : 'Access requested.',
        entityType: 'application',
        entityId: request.applicationId,
        targetUserId: request.requesterId,
        metadata: {
          applicationName: application.name,
          accessRequestId: request.id,
          ...(request.accessLevel !== null
            ? { accessLevel: request.accessLevel }
            : {}),
        },
      });
    } catch {
      // Best-effort: a failed nudge never affects the already-committed request.
    }
  }
}
