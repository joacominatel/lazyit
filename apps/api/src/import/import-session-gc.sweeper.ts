import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How often the GC pass runs. Hourly is ample for short-lived (24h-TTL) wizard sessions. */
export const IMPORT_GC_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The migrator session GARBAGE-COLLECTOR (ADR-0069 §2, wave 4b, #635). An `ImportSession` is TRANSIENT
 * (`expiresAt` = 24h from upload) — it holds the operator's uploaded rows as transient scratch, NOT
 * audit data — so once it expires it is HARD-DELETED, cascading to its `ImportRow`s (and, by the
 * schema's `onDelete: Cascade`, its `ImportRun` ledger rows; the durable asset→import correlation
 * survives independently on each created asset's `CREATED` `AssetHistory` provenance — ADR-0069 §8/§9).
 *
 * Structured exactly like {@link NotificationsRetentionSweeper}: a plain `setInterval` (no
 * `@nestjs/schedule` dependency — it isn't installed), `unref`'d so it never holds the process open,
 * NOT started under `NODE_ENV=test` (the Jest suite mocks Prisma / has no real DB), re-entrancy guarded
 * so a slow pass never overlaps the next tick, and the whole pass try/caught so a transient DB error
 * never crashes the app.
 *
 * SAFETY: a session that is mid-commit (`COMMITTING`) is NEVER swept even if past its TTL — yanking it
 * would orphan an in-flight chunked commit. Every other status past `expiresAt` is swept; the 24h TTL
 * is far beyond any commit's runtime, so this only ever reaps abandoned/finished sessions.
 */
@Injectable()
export class ImportSessionGcSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportSessionGcSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, IMPORT_GC_SWEEP_INTERVAL_MS);
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
   * One GC pass: hard-delete every expired session that is NOT mid-commit; the FK cascade reaps its
   * `ImportRow`s and `ImportRun` ledger rows. Returns how many sessions were deleted (telemetry/tests).
   * Re-entrancy guarded; the whole pass is try/caught so a failing sweep never aborts the app or
   * overlaps the next tick. Public so a test / operator can trigger it directly.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const now = new Date();
      const { count } = await this.prisma.importSession.deleteMany({
        where: {
          expiresAt: { lt: now },
          // Never reap a session whose commit is still running (24h TTL is well past any commit).
          status: { not: 'COMMITTING' },
        },
      });
      if (count > 0) {
        this.logger.log(
          `Hard-deleted ${count} expired import session(s) (+ cascaded rows) past their 24h TTL.`,
        );
      }
      return count;
    } catch (err) {
      this.logger.error(
        `Import session GC sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
