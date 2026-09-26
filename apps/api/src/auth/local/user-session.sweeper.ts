import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** How often the per-device session table is swept. */
export const USER_SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** What one pass removed. */
export interface UserSessionSweepResult {
  expired: number;
  stale: number;
}

/**
 * Purges per-device session rows that can no longer authenticate (issue #1420, ADR-0086 §9). Protocol
 * state, not domain data (the PasswordResetToken / OAuthToken precedent), so they are hard-deleted:
 *   - rows past their `expiresAt` (a default 12h session whose token has expired);
 *   - rows minted at an epoch other than their user's current `sessionEpoch` — left behind by a bump
 *     from a lever that does not touch this table itself (admin reset, deactivation, offboarding,
 *     directory offboard, the recovery CLI). Their tokens already fail the epoch check.
 * A remember-me row has no expiry and stays until it is ended or its epoch goes stale.
 *
 * The `OAuthSweeper` shape: a plain unref'd `setInterval`, not started under `NODE_ENV=test`,
 * re-entrancy guarded, and a failing pass never crashes the app.
 */
@Injectable()
export class UserSessionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserSessionSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, USER_SESSION_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(now: Date = new Date()): Promise<UserSessionSweepResult> {
    const empty = { expired: 0, stale: 0 };
    if (this.running) return empty;
    this.running = true;
    try {
      const expired = await this.prisma.userSession.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      // A column-to-column comparison across the relation, which the Prisma query API cannot express.
      // Fixed statement, no interpolated input.
      const stale = await this.prisma.$executeRaw`
        DELETE FROM "user_sessions" s
        USING "users" u
        WHERE s."userId" = u."id" AND s."epoch" <> u."sessionEpoch"`;
      const result = { expired: expired.count, stale: Number(stale) };
      if (result.expired + result.stale > 0) {
        this.logger.log(
          `Session sweep removed ${result.expired} expired and ${result.stale} revoked session(s).`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error(
        `Session sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    } finally {
      this.running = false;
    }
  }
}
