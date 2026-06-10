import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Notifications older than this are pruned — they are operational nudges, not the audit record. */
export const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days (ADR-0056 §7)

/** How often the retention sweep runs. Hourly is ample for a low-volume, ADMIN-only feed. */
export const NOTIFICATION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The notification RETENTION sweeper (ADR-0056 §7) — the bell is allowed to FORGET. A periodic scan
 * that prunes notifications older than {@link NOTIFICATION_RETENTION_MS} (90 days) and their per-admin
 * read joins. Notifications are operational nudges, NOT the audit system-of-record — the append-only
 * history tables and ledgers ([[0033]]/[[0034]]/[[0023]]/the workflow run ledger) remain the durable
 * record; only the bell forgets.
 *
 * Structured like the engine's WorkflowRunSweeper: a plain `setInterval` (no `@nestjs/schedule`
 * dependency), `unref`'d so it never holds the process open, and NOT started under `NODE_ENV=test` so
 * the Jest suite (mocked Prisma, no real DB) is unaffected. Re-entrancy guarded so a slow pass never
 * overlaps the next tick; the whole pass is try/caught so a transient DB error never crashes the app.
 *
 * Deletion order honours the `NotificationRead → Notification` RESTRICT FK: the read joins for the
 * expired events are deleted FIRST, then the events — never relying on a cascade. The sweep is the ONLY
 * deleter of a notification (the model is otherwise append-only).
 */
@Injectable()
export class NotificationsRetentionSweeper
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsRetentionSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, NOTIFICATION_SWEEP_INTERVAL_MS);
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
   * One retention pass: delete the read joins for expired notifications, then the notifications. Returns
   * how many notification rows were pruned (for telemetry / tests). Re-entrancy guarded; the whole pass
   * is try/caught so a failing sweep never aborts the app or overlaps the next tick. Public so a test /
   * operator can trigger it directly.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS);
      // Read joins FIRST (RESTRICT FK): clear the children of the expired events before the events.
      await this.prisma.notificationRead.deleteMany({
        where: { notification: { createdAt: { lt: cutoff } } },
      });
      const { count } = await this.prisma.notification.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(
          `Pruned ${count} notification(s) older than 90 days (retention sweep).`,
        );
      }
      return count;
    } catch (err) {
      this.logger.error(
        `Notification retention sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
