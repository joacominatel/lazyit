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
import { Prisma, type Role } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

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
  /**
   * Who SEES this notification (ADR-0056 amendment, #453). `null`/omitted = a BROADCAST to every
   * `notification:read` holder (the v1 admin feed, the default for all existing emitters). A uuid = a
   * TARGETED nudge that lands ONLY in that user's own bell — visible even when they hold no
   * `notification:read`.
   */
  recipientUserId?: string | null;
  /** Small, REDACTED extra context (names/ids only). */
  metadata?: Record<string, unknown> | null;
}

/**
 * The CALLER reading the bell — their human user id (the per-user read-state key) plus their DB role
 * (the input to the broadcast-visibility check, ADR-0056 amendment). The service resolves whether the
 * role holds `notification:read` to decide if the caller may see the broadcast set; the controller only
 * forwards the principal's id + role, never a pre-computed permission, so the authZ decision lives in
 * one place.
 */
export interface NotificationViewer {
  userId: string;
  role: Role;
}

/**
 * NotificationsService — the in-app notification bell store (ADR-0056). An APPEND-ONLY `Notification`
 * event table + a per-user `NotificationRead` join, delivered by POLL (v1). Two faces:
 *   - the READ API the controller exposes: the caller's paged feed with a folded-in per-caller `read`
 *     flag, the unread count (an anti-join), and mark-one / mark-all read.
 *   - the EMIT API the post-commit emitters call ({@link emit}) — idempotent on `dedupeKey`.
 *
 * Fan-out-on-READ: an event is written ONCE; "unread for caller A" = a *visible* Notification with no
 * NotificationRead row for A. Storage is proportional to EVENTS, not events × admins, and the audience
 * is computed at READ time, so it is always current — an admin added after an event still sees it; a
 * removed admin leaves no stale rows.
 *
 * VISIBILITY (the auth contract, ADR-0056 amendment 2026-06-14, #453). Every read method scopes its
 * query by {@link visibilityWhere}: a caller sees
 *   (a) their OWN TARGETED rows (`recipientUserId == caller`) — ALWAYS, regardless of `notification:read`
 *       (so a non-admin can read a notification addressed to them, the same "you see your own" shape as
 *       `GET /users/me`); PLUS
 *   (b) the BROADCAST set (`recipientUserId IS NULL`) — ONLY IF the caller's role holds
 *       `notification:read` (ADMIN-only by default).
 * This is enforced in ONE place — the service — so the controller can stay open to any authenticated
 * human and the scope can never be bypassed. Mark-read/unread-count reuse the SAME `where`, so they are
 * IDOR-safe by construction: a caller can never mark or count a row they cannot see (notably another
 * user's targeted notification, or — for a non-admin — any broadcast row).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * The visibility scope for a caller (ADR-0056 amendment, #453) — the single source of truth every
   * read path applies. Always includes the caller's own targeted rows; includes the broadcast set only
   * when the role holds `notification:read`. Returned as a Prisma `where` fragment so `findPage`,
   * `unreadCount`, `markRead` and `markAllRead` all scope IDENTICALLY (no path can widen the audience).
   */
  private async visibilityWhere(
    viewer: NotificationViewer,
  ): Promise<Prisma.NotificationWhereInput> {
    const canReadBroadcast = await this.permissions.hasAll(viewer.role, [
      'notification:read',
    ]);
    // (a) own targeted rows — always; (b) broadcast rows — only for a notification:read holder.
    const or: Prisma.NotificationWhereInput[] = [
      { recipientUserId: viewer.userId },
    ];
    if (canReadBroadcast) {
      or.push({ recipientUserId: null });
    }
    return { OR: or };
  }

  /**
   * The caller's notification feed (newest-first, paged per ADR-0030) — unread AND read, each item
   * carrying its per-CALLER `read` flag. SCOPED by {@link visibilityWhere} (ADR-0056 amendment, #453):
   * the caller's own targeted rows always, plus the broadcast set only if they hold `notification:read`.
   * The read flag is folded in by LEFT-joining the caller's NotificationRead rows (Prisma `include`
   * filtered to `userId`), so the web never stitches two lists. `total` is the count over the caller's
   * VISIBLE (retained) set. Runs the page + count in one transaction so the total can't drift from the
   * page.
   */
  async findPage(
    viewer: NotificationViewer,
    page: PageQuery,
  ): Promise<Page<NotificationWire>> {
    const { take, skip } = offsetOf(page);
    const where = await this.visibilityWhere(viewer);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        // Only the CALLER's read row (if any) — the anti-join that yields the per-caller `read` flag.
        include: {
          reads: { where: { userId: viewer.userId }, select: { id: true }, take: 1 },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);
    const items = rows.map((row) => this.toWire(row, row.reads.length > 0));
    return pageOf(items, total, page);
  }

  /**
   * The badge number — the caller's UNREAD count (ADR-0056 §2). An anti-join SCOPED to the caller's
   * visible set ({@link visibilityWhere}): notifications the caller can SEE with NO NotificationRead row
   * for them. Combining the visibility `where` with `reads: { none }` is what makes the count IDOR-safe
   * — a non-admin can never count broadcast rows, and no caller can count another user's targeted rows.
   */
  async unreadCount(viewer: NotificationViewer): Promise<number> {
    const where = await this.visibilityWhere(viewer);
    return this.prisma.notification.count({
      where: { AND: [where, { reads: { none: { userId: viewer.userId } } }] },
    });
  }

  /**
   * Mark ONE notification read for the caller — IDOR-safe (ADR-0056 amendment, #453). First confirms the
   * notification is WITHIN the caller's visible scope ({@link visibilityWhere}); a row the caller cannot
   * see (another user's targeted notif, or — for a non-admin — any broadcast row) is a clean no-op
   * (`marked: 0`), never marked and never disclosed. A missing/retention-pruned id is likewise a no-op
   * (the bell never 404s on a stale client). Returns `marked` (0 if it was invisible, already read or
   * absent) + the FRESH (scoped) unread count so the badge updates without a refetch.
   */
  async markRead(
    viewer: NotificationViewer,
    notificationId: string,
  ): Promise<MarkReadResult> {
    const where = await this.visibilityWhere(viewer);
    // Gate on VISIBILITY before writing any read row: the caller may only mark what they can see.
    const visible = await this.prisma.notification.findFirst({
      where: { AND: [where, { id: notificationId }] },
      select: { id: true },
    });
    if (!visible) {
      // Invisible (not theirs / not a permitted broadcast) or absent → no-op, no disclosure.
      return { marked: 0, unread: await this.unreadCount(viewer) };
    }

    let marked = 0;
    try {
      // create() throws P2002 on the (notificationId, userId) unique if already read → idempotent: the
      // mark is a no-op and `marked` stays 0. A racing retention delete throws P2003 (FK) → also a no-op.
      await this.prisma.notificationRead.create({
        data: { notificationId, userId: viewer.userId },
      });
      marked = 1;
    } catch (err) {
      if (!this.isAlreadyReadOrAbsent(err)) {
        throw err;
      }
    }
    const unread = await this.unreadCount(viewer);
    return { marked, unread };
  }

  /**
   * Mark ALL the caller's currently-unread VISIBLE notifications read (ADR-0056 §2). SCOPED by
   * {@link visibilityWhere}: it only ever marks rows the caller can see, so mark-all can never touch
   * another user's targeted notification or (for a non-admin) a broadcast row. Inserts a NotificationRead
   * row for every visible notification the caller has no read row for, in one `createMany` with
   * `skipDuplicates` (so a concurrent mark-one can't collide). Returns how many rows were newly written
   * (`marked`) + the fresh unread count (0 after a successful mark-all).
   */
  async markAllRead(viewer: NotificationViewer): Promise<MarkReadResult> {
    const where = await this.visibilityWhere(viewer);
    const unreadIds = await this.prisma.notification.findMany({
      where: { AND: [where, { reads: { none: { userId: viewer.userId } } }] },
      select: { id: true },
    });
    if (unreadIds.length === 0) {
      return { marked: 0, unread: 0 };
    }
    const result = await this.prisma.notificationRead.createMany({
      data: unreadIds.map((n) => ({ notificationId: n.id, userId: viewer.userId })),
      skipDuplicates: true,
    });
    const unread = await this.unreadCount(viewer);
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
          ...(input.recipientUserId != null
            ? { recipientUserId: input.recipientUserId }
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
      recipientUserId: string | null;
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
      recipientUserId: row.recipientUserId,
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
      case 'secret.vault_setup':
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
