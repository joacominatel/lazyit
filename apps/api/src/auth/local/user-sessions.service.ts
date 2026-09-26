import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { UserSession, UserSessionList } from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UserHistoryService } from '../../user-history/user-history.service';
import { parseUserAgent } from './user-agent';
import { UserSessionStore } from './user-session.store';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most sessions one list returns — far above what one person holds; a bound on a user-driven table. */
export const SESSION_LIST_LIMIT = 100;

/**
 * UserSessionsService — the caller's own per-device sessions (issue #1420, ADR-0086 §9): list them and end
 * one. Self-service only: every query is scoped to the authenticated user's id, so another user's session
 * id is indistinguishable from an unknown one (404). An admin ends another user's sessions through the
 * existing levers — deactivation, offboarding, an admin password reset with `revokeSessions` — which bump
 * `sessionEpoch`, so every one of that user's tokens dies and their rows drop out of the list.
 *
 * A row is listed only while it is LIVE: minted at the user's current `sessionEpoch` (a later bump from
 * any lever leaves stale rows behind until the sweeper purges them) and not past its expiry.
 */
@Injectable()
export class UserSessionsService {
  private readonly sessions: UserSessionStore;

  constructor(
    private readonly prisma: PrismaService,
    private readonly history: UserHistoryService,
    @Optional() sessions?: UserSessionStore,
  ) {
    this.sessions = sessions ?? new UserSessionStore(prisma);
  }

  /**
   * The caller's live sessions, most recently active first, with `current` on the one the request came
   * from. `currentSessionId` null means the caller's token predates per-device sessions: it has no row,
   * and `currentIsLegacy` tells the UI to show one synthetic entry for it. Outside local mode there are no
   * lazyit-minted sessions, so the list is empty.
   */
  async list(
    user: User,
    currentSessionId: string | null,
    now: Date = new Date(),
  ): Promise<UserSessionList> {
    if (process.env.AUTH_MODE !== 'local') {
      return { sessions: [], currentIsLegacy: false };
    }
    const rows = await this.prisma.userSession.findMany({
      where: {
        userId: user.id,
        epoch: user.sessionEpoch,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      take: SESSION_LIST_LIMIT,
    });
    const sessions = rows.map((row): UserSession => ({
      id: row.id,
      ...parseUserAgent(row.userAgent),
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      rememberMe: row.rememberMe,
      current: row.id === currentSessionId,
    }));
    return { sessions, currentIsLegacy: currentSessionId === null };
  }

  /**
   * End ONE of the caller's sessions: delete its row, so the guard refuses its token on the next request,
   * and record `SESSION_ENDED` (payload `{ sessionId, current }`) in the same transaction. Ending the
   * caller's own current session is signing out of this device. 404 for an id that is malformed, unknown,
   * already ended, stale (a later epoch bump) or another user's — one answer for all, no oracle.
   */
  async end(
    user: User,
    sessionId: string,
    currentSessionId: string | null,
  ): Promise<void> {
    const notFound = () => new NotFoundException('Session not found');
    if (!UUID_REGEX.test(sessionId)) {
      throw notFound();
    }
    await this.prisma.$transaction(async (tx) => {
      const ended = await tx.userSession.deleteMany({
        where: { id: sessionId, userId: user.id, epoch: user.sessionEpoch },
      });
      if (ended.count === 0) {
        throw notFound();
      }
      await this.history.record(tx, {
        userId: user.id,
        eventType: 'SESSION_ENDED',
        payload: { sessionId, current: sessionId === currentSessionId },
        actor: { userId: user.id },
      });
    });
  }
}
