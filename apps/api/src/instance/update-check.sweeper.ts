import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { UpdateService } from './update.service';

/** How often the update check runs. Weekly — the ADR's "check github.com weekly" cadence (§1). */
export const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * A jittered delay before the FIRST check after boot (0–30 min). The stack redeploys reset the timer,
 * so this spreads the check off the exact boot instant (avoids a thundering herd at a fleet-wide
 * restart — n/a for single-host, but cheap and polite to github.com) and lets boot settle first.
 */
export const UPDATE_CHECK_INITIAL_JITTER_MS = 30 * 60 * 1000; // up to 30 min

/**
 * UpdateCheckSweeper — the opt-in weekly update check (ADR-0084 §1), built on the exact sweep mold as
 * {@link NotificationsRetentionSweeper}: a plain `setInterval` (NO `@nestjs/schedule` — the codebase
 * deliberately avoids it), `unref`'d so it never holds the process open, re-entrancy guarded, the whole
 * pass try/caught (here inside {@link UpdateService.runCheck}, which is fail-soft), and NOT started
 * under NODE_ENV=test. The actual work (fetch + compare + cache + email) lives in the service so it is
 * unit-testable without a timer; the sweeper only schedules it. The FIRST run is jittered off boot.
 */
@Injectable()
export class UpdateCheckSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdateCheckSweeper.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly updates: UpdateService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    // Jittered first run, then a steady weekly interval.
    const jitter = Math.floor(Math.random() * UPDATE_CHECK_INITIAL_JITTER_MS);
    this.initialTimer = setTimeout(() => {
      void this.tick();
      this.interval = setInterval(() => {
        void this.tick();
      }, UPDATE_CHECK_INTERVAL_MS);
      this.interval.unref?.();
    }, jitter);
    this.initialTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * One scheduled tick: re-entrancy guarded (a slow check never overlaps the next), delegating to the
   * fail-soft {@link UpdateService.runCheck}. Public so a test/operator can trigger it directly.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.updates.runCheck();
    } catch (err) {
      // runCheck is already fail-soft; this is belt-and-suspenders so a timer callback never throws.
      this.logger.error(
        `update check tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
