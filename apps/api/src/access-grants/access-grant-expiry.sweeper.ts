import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessGrantsService } from './access-grants.service';

/** Read a positive-integer ms env var, falling back to `fallback` when unset/blank/non-numeric. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How often the expiry sweep runs. Expiry is coarse (date-grained), so once per ~quarter-hour is ample. */
export const ACCESS_GRANT_EXPIRY_SWEEP_INTERVAL_MS_DEFAULT = 15 * 60 * 1000; // 15 minutes

/**
 * ponytail: bounded batch per pass so a large backlog (e.g. the first sweep after enabling this) never
 * stampedes — each pass takes at most this many expired grants and the next tick picks up the rest. A
 * const, not an env knob: the cap only shapes per-pass load, and 200 grant-revokes/15-min drains any
 * realistic small-team backlog within minutes. Raise it (or make it env-tunable) only if a real backlog
 * is ever observed to drain too slowly.
 */
const EXPIRY_SWEEP_BATCH = 200;

/**
 * The AccessGrant EXPIRY sweeper (ADR-0023, amended): auto-revoke grants that have passed `expiresAt`.
 * Before this, `expiresAt` was informative-only and an expired grant stayed active until a human revoked
 * it. Each pass finds active grants (`revokedAt = null`) whose `expiresAt` is in the past and revokes
 * each through the EXISTING {@link AccessGrantsService.revoke} path — so the deprovision workflow fires
 * (per the LAST_ACTIVE_GRANT policy, race-safe via the advisory lock) and the revoke is attributed,
 * EXACTLY as an offboarding revoke. It is deliberately NOT a blind `updateMany`: that would skip the
 * deprovision workflow and the audit run, silently leaving external access provisioned.
 *
 * Structured exactly like {@link InfraAgentStalenessSweeper}: a plain `setInterval` (no `@nestjs/schedule`
 * dependency — it isn't installed), `unref`'d so it never holds the process open, NOT started under
 * `NODE_ENV=test` (the Jest suite mocks Prisma / has no real DB), re-entrancy guarded so a slow pass
 * never overlaps the next tick, and the whole pass try/caught so a transient DB error never crashes the
 * app. Interval is env-tunable (`ACCESS_GRANT_EXPIRY_SWEEP_INTERVAL_MS`) with a sane default.
 *
 * Actor attribution: an automatic revoke has NO human/SA actor, so it goes through `revoke()` with an
 * undefined principal → the documented SYSTEM/unknown sentinel (`revokedById` and `revokedBySaId` both
 * null; see ADR-0023 "a future scheduler leaves them null" and {@link ActorService.resolveActor}). The
 * grant's existing `notes` are deliberately preserved (not clobbered with "expired") — the null actor on
 * a set `revokedAt` already identifies an automatic revoke, and there is no dedicated `revokedReason`
 * column to carry the word.
 *
 * ponytail: revoking through the per-grant `revoke()` (NOT a bulk `updateMany`) is O(n) and fires a
 * deprovision workflow per last-active-grant — that cost is the POINT (it mirrors offboarding exactly).
 * The per-pass batch cap ({@link EXPIRY_SWEEP_BATCH}) keeps a backlog from stampeding.
 */
@Injectable()
export class AccessGrantExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessGrantExpirySweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly intervalMs = envMs(
    'ACCESS_GRANT_EXPIRY_SWEEP_INTERVAL_MS',
    ACCESS_GRANT_EXPIRY_SWEEP_INTERVAL_MS_DEFAULT,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: AccessGrantsService,
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
   * One sweep: revoke up to {@link EXPIRY_SWEEP_BATCH} active grants whose `expiresAt` is in the past,
   * each through the existing system-attributed `revoke()` path. Returns how many were revoked
   * (telemetry/tests). Re-entrancy guarded; the whole pass is try/caught so a failing sweep never aborts
   * the app or overlaps the next tick. Each grant's revoke is independently guarded so a concurrent
   * revoke (409) or a single failure never aborts the rest of the batch. Public so a test/operator can
   * run it on demand.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const now = new Date();
      const expired = await this.prisma.accessGrant.findMany({
        where: {
          revokedAt: null,
          expiresAt: { not: null, lt: now },
        },
        select: { id: true },
        take: EXPIRY_SWEEP_BATCH,
      });
      let revoked = 0;
      for (const { id } of expired) {
        try {
          // Undefined principal → system/unknown actor (both actor FKs null). `{}` body keeps the
          // grant's existing notes. Fires the deprovision workflow exactly like an offboarding revoke.
          await this.grants.revoke(id, {}, undefined);
          revoked += 1;
        } catch (err) {
          // A grant revoked concurrently (409) or a transient per-grant failure is skipped, never fatal
          // to the batch — the next pass re-evaluates anything still active and past expiry.
          this.logger.warn(
            `Expiry auto-revoke skipped grant ${id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (revoked > 0) {
        this.logger.log(
          `Auto-revoked ${revoked} expired access grant(s) (expiry on/before ${now.toISOString()}).`,
        );
      }
      return revoked;
    } catch (err) {
      this.logger.error(
        `Access grant expiry sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
