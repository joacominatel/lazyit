import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeClientIp, normalizeUserAgent } from './user-agent';

/**
 * How often a session's `lastSeenAt` may be written: at most once per window per session, never per
 * request (issue #1420, CEO decision). The value shown in the list is therefore approximate to this window.
 */
export const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Most session rows one user keeps (#1420 review). Opening a session beyond it deletes the user's least
 * recently active rows in the same step — a bound on a table any sign-in grows, and on what one scripted
 * login loop can write. Far above what one person uses; the evicted devices simply sign in again.
 */
export const MAX_SESSIONS_PER_USER = 50;

/** What the sign-in request says about the device, stored on the session row. */
export interface SessionDeviceMeta {
  userAgent: string | null;
  ip: string | null;
}

/** The fields a new session row needs besides what the minted token decides (its expiry). */
export interface NewSession {
  userId: string;
  epoch: number;
  rememberMe: boolean;
  meta: SessionDeviceMeta;
}

/** A minted token and its `exp` in epoch seconds (null = remember-me) — what `LocalCredentialService` returns. */
export interface MintedToken {
  token: string;
  expiresAt: number | null;
}

/** A client that can reach the `userSession` delegate — the root client or an interactive transaction. */
export type SessionDb = Pick<Prisma.TransactionClient, 'userSession'>;

/** The device metadata of a request: its User-Agent header and Express's verified client IP (SEC-010). */
export function sessionMetaFromRequest(
  request: Pick<Request, 'headers' | 'ip'> | undefined,
): SessionDeviceMeta {
  if (!request) {
    return { userAgent: null, ip: null };
  }
  return {
    userAgent: normalizeUserAgent(request.headers?.['user-agent']),
    ip: normalizeClientIp(request.ip),
  };
}

/**
 * UserSessionStore — persistence of the per-device local sessions (issue #1420, ADR-0086 §9) and the
 * guard's per-request check. Provided by the @Global AuthModule (the guard needs it) and injected by the
 * LocalAuthModule's services; it depends on Prisma only.
 *
 * The session row is protocol state: ending a session HARD-deletes it (the PasswordResetToken / OAuthToken
 * precedent), and the audit record is the `SESSION_ENDED` UserHistory row the caller writes.
 */
@Injectable()
export class UserSessionStore {
  private readonly logger = new Logger(UserSessionStore.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a new session: pick its id, let `mint` sign a token carrying it as `sid`, then record the row
   * with the token's own expiry. If the row cannot be written the error propagates and the token is never
   * handed out — there is no untracked `sid`-less fallback.
   */
  async open<T extends MintedToken>(
    session: NewSession,
    mint: (sessionId: string) => Promise<T>,
    db: SessionDb = this.prisma,
  ): Promise<T> {
    const id = randomUUID();
    const minted = await mint(id);
    await db.userSession.create({
      data: {
        id,
        userId: session.userId,
        epoch: session.epoch,
        rememberMe: session.rememberMe,
        userAgent: session.meta.userAgent,
        ip: session.meta.ip,
        expiresAt:
          minted.expiresAt === null ? null : new Date(minted.expiresAt * 1000),
      },
      select: { id: true },
    });
    await this.evictBeyondCap(session.userId, db);
    return minted;
  }

  /** Delete the user's least recently active rows beyond {@link MAX_SESSIONS_PER_USER}. */
  private async evictBeyondCap(userId: string, db: SessionDb): Promise<void> {
    const overflow = await db.userSession.findMany({
      where: { userId },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      skip: MAX_SESSIONS_PER_USER,
      select: { id: true },
    });
    if (overflow.length > 0) {
      await db.userSession.deleteMany({
        where: { id: { in: overflow.map((row) => row.id) } },
      });
    }
  }

  /**
   * The guard's check for a token that carries a `sid`: one primary-key read. The session is live when the
   * row exists, belongs to the token's user, was minted at the token's epoch and has not expired. A live
   * session's `lastSeenAt` is then refreshed — at most once per {@link SESSION_LAST_SEEN_THROTTLE_MS}, with
   * a conditional write so concurrent requests do not all write, and best-effort (a failed write never
   * fails the request).
   *
   * No cache on purpose: ending a session must take effect on the very next request, on every replica. The
   * cost is one indexed point-read per authenticated local request with a `sid`, next to the user re-load
   * the guard already does (INV-1).
   */
  async isLive(
    sessionId: string,
    userId: string,
    epoch: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const row = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, epoch: true, expiresAt: true, lastSeenAt: true },
    });
    if (
      !row ||
      row.userId !== userId ||
      row.epoch !== epoch ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())
    ) {
      return false;
    }
    const threshold = new Date(now.getTime() - SESSION_LAST_SEEN_THROTTLE_MS);
    if (row.lastSeenAt.getTime() <= threshold.getTime()) {
      try {
        await this.prisma.userSession.updateMany({
          where: { id: sessionId, lastSeenAt: { lte: threshold } },
          data: { lastSeenAt: now },
        });
      } catch (err) {
        this.logger.warn(
          `lastSeenAt refresh failed for session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return true;
  }

  /**
   * Move a session row from `fromEpoch` onto `toEpoch` and a new expiry — the caller's own session across
   * a password change, which re-mints its token under the same `sid`. Conditional on the row still being
   * at `fromEpoch`, so a row left stale by a concurrent bump is never revived. Returns false when the row
   * is gone or stale, in which case the caller opens a new one.
   */
  async carryOver(
    sessionId: string,
    userId: string,
    fromEpoch: number,
    toEpoch: number,
    expiresAt: number | null,
    db: SessionDb = this.prisma,
  ): Promise<boolean> {
    const result = await db.userSession.updateMany({
      where: { id: sessionId, userId, epoch: fromEpoch },
      data: {
        epoch: toEpoch,
        expiresAt: expiresAt === null ? null : new Date(expiresAt * 1000),
        lastSeenAt: new Date(),
      },
    });
    return result.count === 1;
  }

  /**
   * End every session row of a user — "sign out everywhere" and the password flows, alongside their
   * `sessionEpoch` bump. `keepId` spares one row (the caller's own session across a password change).
   */
  async endAll(
    userId: string,
    db: SessionDb = this.prisma,
    keepId?: string | null,
  ): Promise<number> {
    const result = await db.userSession.deleteMany({
      where: { userId, ...(keepId ? { id: { not: keepId } } : {}) },
    });
    return result.count;
  }
}
