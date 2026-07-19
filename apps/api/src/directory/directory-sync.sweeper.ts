import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DIRECTORY_SYNC_INTERVAL_MS_DEFAULT,
  directoryEnvMs,
} from './directory.constants';
import { DirectoryReconcileService } from './directory-reconcile.service';

/**
 * The AD/LDAP directory-sync sweeper (issue #839, ADR-0091). Periodically runs the read-only reconcile so
 * the directory stays in step without a human clicking "Sync now".
 *
 * DEVIATION FROM ADR-0091's WORDING (documented in the ADR): the ADR originally proposed a "scheduled
 * (BullMQ repeatable) reconcile", but the repo has ZERO repeatable/JobScheduler jobs — all 8 periodic
 * tasks are setInterval sweepers. So this is built on the {@link InfraAgentStalenessSweeper} mold to match
 * the codebase (one line before fifty): a plain `setInterval` (no `@nestjs/schedule` dependency — it isn't
 * installed), `unref`'d so it never holds the process open, NOT started under `NODE_ENV=test`, re-entrancy
 * guarded (by the reconcile service's own guard AND this one), and the whole pass try/caught so a transient
 * error never crashes the app. The interval is env-tunable (`DIRECTORY_SYNC_INTERVAL_MS`). "Sync now"
 * (POST /directory/sync) calls the SAME reconcile method — no queue.
 *
 * The reconcile itself no-ops cleanly when directory sync is disabled/unconfigured (resolveConfig → null),
 * so the sweeper is safe to always arm; it does nothing until an admin enables a connection.
 */
@Injectable()
export class DirectorySyncSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DirectorySyncSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly intervalMs = directoryEnvMs(
    'DIRECTORY_SYNC_INTERVAL_MS',
    DIRECTORY_SYNC_INTERVAL_MS_DEFAULT,
  );

  constructor(private readonly reconcile: DirectoryReconcileService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep: run the reconcile. Re-entrancy guarded here too (belt and braces with the reconcile's own
   * guard); the whole pass is try/caught so a failing sync never aborts the app or overlaps the next tick.
   * Public so a test/operator can trigger it. Logs redacted counts only (never PII/secrets).
   */
  async sweep(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.reconcile.reconcile();
      if (!result.ok && result.error) {
        this.logger.warn(
          `Scheduled directory sync did not complete: ${result.error}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Directory sync sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
