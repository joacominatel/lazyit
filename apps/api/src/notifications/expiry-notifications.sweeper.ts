import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WARRANTY_EXPIRING_WITHIN_DAYS } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/** Read a positive-integer ms env var, falling back to `fallback` when unset/blank/non-numeric. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How often the expiry look-ahead runs. Daily — expiry is date-grained, so a slow cadence is ample. */
export const EXPIRY_NOTIFICATION_SWEEP_INTERVAL_MS_DEFAULT = MS_PER_DAY;

/**
 * The access-grant expiry look-ahead LEAD (days): notify when an active grant's `expiresAt` falls
 * inside this window (and it will soon auto-revoke, ADR-0023). Its OWN horizon — grants (contractor/temp
 * access) run shorter than hardware warranties, so a two-week heads-up gives the team runway to re-grant.
 *
 * ponytail: a const, not an env knob — the window only shapes how early the one-per-grant nudge fires,
 * and 14 days is the standard "renew this soon" runway. Warranties reuse the shared
 * `WARRANTY_EXPIRING_WITHIN_DAYS` (90) — the SAME horizon the dashboard tile already shows. Make either
 * env-tunable only if a real deployment asks for a different lead time.
 */
export const ACCESS_GRANT_EXPIRING_NOTIFY_WITHIN_DAYS = 14;

/**
 * ponytail: bounded batch per pass per type so a large backlog (e.g. the first sweep after enabling this,
 * or a bulk import of assets all warrantied to the same month) never stampedes the notification table in
 * one tick. Each pass walks the window soonest-expiry first, skips items that already have their dedupe
 * row, and emits at most this many NEW notices per type; the next pass picks up the rest, so the backlog
 * only ever shrinks. A const, not an env knob: it only shapes per-pass load. Also the page size.
 */
export const EXPIRY_NOTIFY_BATCH = 200;

/** A `YYYY-MM-DD` day stamp for the dedupe key — collapses the daily re-scan to ONE row per date. */
function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The proactive EXPIRY notification sweeper (ADR-0056 §3, issue #1070). A daily look-ahead that emits a
 * one-time heads-up BEFORE two silent lifecycle events fire:
 *   - `warranty_expiring`      — an asset's `warrantyEnd` entered the look-ahead window (the dashboard
 *                                already shows the tile; this makes it a nudge). Broadcast, admin-facing.
 *   - `access_grant_expiring`  — an active grant's `expiresAt` entered the window and it will soon
 *                                AUTO-REVOKE (ADR-0023) — before this a small team lost contractor/temp
 *                                access with no warning. Broadcast to the admins who can re-grant, with
 *                                `targetUserId` = the grantee for the "about whom" click-through.
 *
 * The read WINDOWS are the exact shape the dashboard already computes (`warrantyEnd: { gt: now, lte:
 * cutoff }` / `expiresAt: { gt: now, lte: cutoff }`, {@link DashboardService.getSummary}) — reused, not
 * reinvented; only the projection differs (this needs names to build the copy).
 *
 * ANTI-SPAM / DEDUP — the delicate part. Each emit carries a `dedupeKey` that pins ONE row per item per
 * expiry DATE (`<type>:<id>:<YYYY-MM-DD>`), and {@link NotificationsService.emit} is idempotent on the
 * `Notification.dedupeKey` UNIQUE (a duplicate collapses to a no-op). So the FIRST daily pass that finds
 * an item inside the window emits; every later pass re-finds the same item but the identical key makes
 * it a silent no-op — no once-per-day spam, WITHOUT any marker column or migration. This is the same
 * per-version dedup the weekly `update.available` check uses.
 *
 * ponytail — the dedup CEILING: the guarantee rests on the persisted dedupe row outliving the window.
 * The bell's 90-day retention sweep prunes old rows, so a warranty could in theory re-emit if its row
 * were pruned while the item is still inside the window. It cannot in practice: the warranty window IS 90
 * days, so an item is only inside the window for its final ≤90 days, and its dedupe row (written when the
 * window opened) is younger than the window it guards — the moment retention could prune the row, the
 * warranty has already lapsed (`warrantyEnd > now` is false) and the item leaves the query. The grant
 * window (14d) is far shorter than retention, so it is never at risk. If the warranty window is ever
 * widened past 90 days, add a persisted per-item marker (a migration) instead of relying on this overlap.
 *
 * Structured exactly like {@link AccessGrantExpirySweeper}: a plain `setInterval` (no `@nestjs/schedule`
 * — not installed), `unref`'d so it never holds the process open, NOT started under `NODE_ENV=test`
 * (Jest mocks Prisma / has no real DB), re-entrancy guarded so a slow pass never overlaps the next tick,
 * and the whole pass try/caught so a transient DB error never crashes the app. `emit()` is itself
 * best-effort and fail-soft, so a single bad row never aborts the batch. Interval is env-tunable
 * (`EXPIRY_NOTIFICATION_SWEEP_INTERVAL_MS`) with a daily default.
 */
@Injectable()
export class ExpiryNotificationsSweeper
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExpiryNotificationsSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly intervalMs = envMs(
    'EXPIRY_NOTIFICATION_SWEEP_INTERVAL_MS',
    EXPIRY_NOTIFICATION_SWEEP_INTERVAL_MS_DEFAULT,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    // Never keep the event loop alive just for the sweep.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One look-ahead pass: emit a proactive heads-up for every asset warranty and access grant that just
   * entered its window (deduped to one per item per expiry date). Returns how many NEW notifications were
   * emitted (telemetry/tests) — re-runs that only hit already-emitted items return 0. Re-entrancy guarded
   * and fully try/caught. Public so a test/operator can run it on demand.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const now = new Date();
      const emitted =
        (await this.sweepWarranties(now)) + (await this.sweepGrants(now));
      if (emitted > 0) {
        this.logger.log(
          `Proactive expiry sweep emitted ${emitted} new notification(s).`,
        );
      }
      return emitted;
    } catch (err) {
      this.logger.error(
        `Expiry notification sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Emit `warranty_expiring` (broadcast) for assets whose warranty enters the shared 90-day window. */
  private async sweepWarranties(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() + WARRANTY_EXPIRING_WITHIN_DAYS * MS_PER_DAY,
    );
    // The EXACT dashboard window (#955): live assets whose warranty ends within N days and hasn't lapsed.
    // Soft-deleted assets are auto-excluded by the ADR-0032 extension; a null warrantyEnd never matches.
    return this.emitUnnotified(
      (skip, take) =>
        this.prisma.asset.findMany({
          where: { warrantyEnd: { gt: now, lte: cutoff } },
          select: { id: true, name: true, assetTag: true, warrantyEnd: true },
          orderBy: [{ warrantyEnd: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
      // warrantyEnd is non-null here (the WHERE guarantees it), but narrow defensively for the type.
      (asset) =>
        asset.warrantyEnd
          ? `warranty_expiring:${asset.id}:${dayStamp(asset.warrantyEnd)}`
          : null,
      (asset, dedupeKey) => {
        const date = dayStamp(asset.warrantyEnd as Date);
        const tag = asset.assetTag ? ` (${asset.assetTag})` : '';
        return this.notifications.emit({
          type: 'warranty_expiring',
          dedupeKey,
          title: `Warranty expiring: ${asset.name}`,
          summary: `${asset.name}${tag} warranty ends ${date}.`,
          entityType: 'asset',
          entityId: asset.id,
          // Broadcast (recipientUserId omitted): the admin feed is who renews/replaces hardware.
          metadata: { assetName: asset.name, warrantyEnd: date },
        });
      },
    );
  }

  /** Emit `access_grant_expiring` (broadcast, about the grantee) for grants entering the 14-day window. */
  private async sweepGrants(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() + ACCESS_GRANT_EXPIRING_NOTIFY_WITHIN_DAYS * MS_PER_DAY,
    );
    // The EXACT dashboard window (expiringSoon): active grants (revokedAt null) whose expiresAt is within
    // N days and hasn't passed. The soft-delete extension does not filter nested relations, hence the
    // explicit parent filters.
    return this.emitUnnotified(
      (skip, take) =>
        this.prisma.accessGrant.findMany({
          where: {
            revokedAt: null,
            expiresAt: { gt: now, lte: cutoff },
            application: { deletedAt: null },
            user: { deletedAt: null },
          },
          select: {
            id: true,
            userId: true,
            expiresAt: true,
            application: { select: { id: true, name: true } },
            user: { select: { firstName: true, lastName: true } },
          },
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
      (grant) =>
        grant.expiresAt
          ? `access_grant_expiring:${grant.id}:${dayStamp(grant.expiresAt)}`
          : null,
      (grant, dedupeKey) => {
        const date = dayStamp(grant.expiresAt as Date);
        const who = `${grant.user.firstName} ${grant.user.lastName}`.trim();
        const app = grant.application.name;
        return this.notifications.emit({
          type: 'access_grant_expiring',
          dedupeKey,
          title: `Access expiring: ${app}`,
          summary: `${who}'s access to ${app} expires ${date} and will be auto-revoked.`,
          entityType: 'application',
          entityId: grant.application.id,
          // The grantee — a secondary click-through + the "about whom" subject (broadcast, admin-facing).
          targetUserId: grant.userId,
          metadata: { granteeName: who, applicationName: app, expiresAt: date },
        });
      },
    );
  }

  /** Skips already-notified items before emitting, so the per-pass cap always reaches new ones. */
  private async emitUnnotified<T>(
    loadPage: (skip: number, take: number) => Promise<T[]>,
    dedupeKeyOf: (item: T) => string | null,
    emitFor: (item: T, dedupeKey: string) => Promise<string | null>,
  ): Promise<number> {
    let skip = 0;
    let attempted = 0;
    let emitted = 0;
    while (attempted < EXPIRY_NOTIFY_BATCH) {
      const page = await loadPage(skip, EXPIRY_NOTIFY_BATCH);
      if (page.length === 0) break;
      skip += page.length;
      const keyed = page.flatMap((item) => {
        const dedupeKey = dedupeKeyOf(item);
        return dedupeKey ? [{ item, dedupeKey }] : [];
      });
      const existing = await this.prisma.notification.findMany({
        where: { dedupeKey: { in: keyed.map((k) => k.dedupeKey) } },
        select: { dedupeKey: true },
      });
      const notified = new Set(existing.map((n) => n.dedupeKey));
      for (const { item, dedupeKey } of keyed) {
        if (notified.has(dedupeKey)) continue;
        if (attempted >= EXPIRY_NOTIFY_BATCH) break;
        attempted += 1;
        if (await emitFor(item, dedupeKey)) emitted += 1;
      }
      if (page.length < EXPIRY_NOTIFY_BATCH) break;
    }
    return emitted;
  }
}
