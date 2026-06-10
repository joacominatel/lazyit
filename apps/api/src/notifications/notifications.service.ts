import { Injectable, Logger } from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  type MarkReadResult,
  type Notification as NotificationWire,
  type NotificationEntityType,
  type NotificationSeverity,
  type NotificationType,
  type Page,
  type PageQuery,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The input an emitter hands {@link NotificationsService.emit} to record one curated nudge (ADR-0056
 * §3). `dedupeKey` makes the emit IDEMPOTENT — a re-run / a flapping consumable / a re-fired listener
 * collapses to ONE row (§4). The caller builds the human `title`/`summary` and the redacted `metadata`
 * (names/ids only — never bodies/secrets/PII, INV-6).
 */
export interface EmitNotificationInput {
  type: NotificationType;
  /** The idempotency key — `<type>:<entityId>` (+ a coarse time bucket for low_stock). UNIQUE per event. */
  dedupeKey: string;
  severity?: NotificationSeverity;
  title: string;
  summary?: string | null;
  entityType?: NotificationEntityType | null;
  entityId?: string | null;
  targetUserId?: string | null;
  /** Small, REDACTED extra context (names/ids only). */
  metadata?: Record<string, unknown> | null;
}

/**
 * NotificationsService — the in-app notification bell store (ADR-0056). An APPEND-ONLY `Notification`
 * event table + a per-admin `NotificationRead` join, delivered by POLL (v1). Two faces:
 *   - the READ API the controller exposes (gated `notification:read`): the caller's paged feed with a
 *     folded-in per-caller `read` flag, the unread count (an anti-join), and mark-one / mark-all read.
 *   - the EMIT API the post-commit emitters call ({@link emit}) — idempotent on `dedupeKey`.
 *
 * Fan-out-on-READ: an event is written ONCE; "unread for admin A" = a Notification with no
 * NotificationRead row for A. Storage is proportional to EVENTS, not events × admins, and the audience
 * (every holder of `notification:read`) is computed at READ time, so it is always current — an admin
 * added after an event still sees it; a removed admin leaves no stale rows.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's notification feed (newest-first, paged per ADR-0030) — unread AND read, each item
   * carrying its per-CALLER `read` flag. The read flag is folded in by LEFT-joining the caller's
   * NotificationRead rows (Prisma `include` filtered to `userId`), so the web never stitches two lists.
   * `total` is the count over the caller's whole (retained) set. Runs the page + count in one
   * transaction so the total can't drift from the page.
   */
  async findPage(userId: string, page: PageQuery): Promise<Page<NotificationWire>> {
    const { take, skip } = offsetOf(page);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        // Only the CALLER's read row (if any) — the anti-join that yields the per-caller `read` flag.
        include: { reads: { where: { userId }, select: { id: true }, take: 1 } },
      }),
      this.prisma.notification.count(),
    ]);
    const items = rows.map((row) => this.toWire(row, row.reads.length > 0));
    return pageOf(items, total, page);
  }

  /**
   * The badge number — the caller's UNREAD count (ADR-0056 §2). One anti-join: notifications with NO
   * NotificationRead row for this admin. Expressed as a `count` with a `reads: { none: { userId } }`
   * filter so Postgres does the anti-join (no N+1, no fetching rows).
   */
  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { reads: { none: { userId } } },
    });
  }

  /**
   * Mark ONE notification read for the caller (idempotent upsert of the NotificationRead row). A
   * missing notification id is a clean no-op (`marked: 0`) — the bell never 404s on a row the retention
   * sweep may have pruned out from under a stale client. Returns `marked` (0 if it was already read or
   * absent) + the FRESH unread count so the badge updates without a refetch.
   */
  async markRead(userId: string, notificationId: string): Promise<MarkReadResult> {
    let marked = 0;
    try {
      // create() throws P2002 on the (notificationId, userId) unique if already read → idempotent: the
      // mark is a no-op and `marked` stays 0. A missing notification throws P2003 (FK) → also a no-op.
      await this.prisma.notificationRead.create({
        data: { notificationId, userId },
      });
      marked = 1;
    } catch (err) {
      if (!this.isAlreadyReadOrAbsent(err)) {
        throw err;
      }
    }
    const unread = await this.unreadCount(userId);
    return { marked, unread };
  }

  /**
   * Mark ALL the caller's currently-unread notifications read (ADR-0056 §2). Inserts a NotificationRead
   * row for every notification the caller has no read row for, in one `createMany` with
   * `skipDuplicates` (so a concurrent mark-one can't collide). Returns how many rows were newly written
   * (`marked`) + the fresh unread count (0 after a successful mark-all).
   */
  async markAllRead(userId: string): Promise<MarkReadResult> {
    const unreadIds = await this.prisma.notification.findMany({
      where: { reads: { none: { userId } } },
      select: { id: true },
    });
    if (unreadIds.length === 0) {
      return { marked: 0, unread: 0 };
    }
    const result = await this.prisma.notificationRead.createMany({
      data: unreadIds.map((n) => ({ notificationId: n.id, userId })),
      skipDuplicates: true,
    });
    const unread = await this.unreadCount(userId);
    return { marked: result.count, unread };
  }

  /**
   * Record one nudge — the EMIT path every post-commit emitter calls (ADR-0056 §3). IDEMPOTENT on
   * `dedupeKey`: a duplicate emit (a retry, a re-fired listener, a flapping consumable) collapses to the
   * EXISTING row via the unique-key swallow, so firing twice is safe (§4) — the best-effort emitter's
   * core contract. NEVER throws to its caller (a notification failure must never roll back or block the
   * domain write that triggered it — the same decoupling as the AccessGrant outbox): any error is
   * logged and swallowed. Returns the (possibly pre-existing) notification id, or null if the emit was
   * swallowed.
   */
  async emit(input: EmitNotificationInput): Promise<string | null> {
    try {
      const created = await this.prisma.notification.create({
        data: {
          type: input.type,
          dedupeKey: input.dedupeKey,
          severity: input.severity ?? this.defaultSeverity(input.type),
          title: input.title,
          ...(input.summary != null ? { summary: input.summary } : {}),
          ...(input.entityType != null ? { entityType: input.entityType } : {}),
          ...(input.entityId != null ? { entityId: input.entityId } : {}),
          ...(input.targetUserId != null
            ? { targetUserId: input.targetUserId }
            : {}),
          ...(input.metadata != null
            ? { metadata: input.metadata as Prisma.InputJsonValue }
            : {}),
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // The unique dedupeKey collision is the EXPECTED idempotent path — a quiet no-op, not an error.
      if (this.isDuplicateDedupe(err)) {
        return null;
      }
      // Any other failure is best-effort: log and swallow so the domain write is never affected.
      this.logger.error(
        `notification emit failed (type=${input.type} dedupeKey=${input.dedupeKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Map a Prisma notification row + the caller's read flag to the shared wire shape. */
  private toWire(
    row: {
      id: string;
      type: string;
      severity: string;
      title: string;
      summary: string | null;
      entityType: string | null;
      entityId: string | null;
      targetUserId: string | null;
      metadata: Prisma.JsonValue | null;
      createdAt: Date;
    },
    read: boolean,
  ): NotificationWire {
    return {
      id: row.id,
      type: row.type as NotificationType,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      summary: row.summary,
      entityType: row.entityType as NotificationEntityType | null,
      entityId: row.entityId,
      targetUserId: row.targetUserId,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      read,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The default presentation severity for a type when an emitter does not pin one (ADR-0056 §5). */
  private defaultSeverity(type: NotificationType): NotificationSeverity {
    switch (type) {
      case 'workflow.run_failed':
        return 'critical';
      case 'critical_app_access':
      case 'admin_granted':
      case 'low_stock':
        return 'warning';
      case 'workflow.manual_task':
        return 'info';
      default:
        return 'info';
    }
  }

  /** True when an error is the expected dedupeKey-unique collision (P2002) — the idempotent no-op. */
  private isDuplicateDedupe(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    );
  }

  /**
   * True when a mark-read error is the benign "already read" (P2002 on the unique read join) or
   * "notification absent" (P2003 FK violation) — both make mark-read a clean no-op.
   */
  private isAlreadyReadOrAbsent(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === 'P2002' || err.code === 'P2003')
    );
  }
}
