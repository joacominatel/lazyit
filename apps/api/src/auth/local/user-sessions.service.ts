import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { UserSession, UserSessionList } from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { OAuthAuditService } from '../../oauth/oauth-audit.service';
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
  private readonly logger = new Logger(UserSessionsService.name);
  private readonly sessions: UserSessionStore;
  private readonly audit: OAuthAuditService;

  // The store comes from AuthModule and the audit from OAuthModule; @Optional with equivalent defaults so
  // a service built by hand from the two original dependencies (the existing specs) behaves the same.
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: UserHistoryService,
    @Optional() sessions?: UserSessionStore,
    @Optional() audit?: OAuthAuditService,
  ) {
    this.sessions = sessions ?? new UserSessionStore(prisma);
    this.audit = audit ?? new OAuthAuditService(prisma);
  }

  /**
   * "Sign out everywhere and disconnect AI apps" (#1699, CEO decision on #1344 Q4): the caller's own,
   * explicit, account-wide revocation. In ONE transaction it bumps BOTH counters and deletes every
   * per-device session row:
   *   - `sessionEpoch` — every local session token dies (including the one making this request), and so
   *     does every AI chat delegation and in-flight run, which re-check it before each step;
   *   - `mcpCredentialEpoch` — every OAuth grant (access and refresh tokens) and personal MCP token stops
   *     on its next use and drops out of the connected-apps list (ADR-0097 decision 8, amended);
   *   - the `UserSession` rows — the device list empties at once rather than waiting for the sweeper.
   * The event is recorded in the OAuth audit trail (`SIGNED_OUT_EVERYWHERE`) in the same transaction.
   *
   * Works in EVERY auth mode, unlike {@link LoginService.logout}, which is a no-op outside local mode: in
   * OIDC mode lazyit mints no web session, so there is no row to delete and the identity provider's
   * session is not lazyit's to end — but the AI connections and chat delegations are, and they die here.
   * The web then drops this browser's cookie.
   *
   * Plain sign-out (`POST /auth/logout`) is unchanged: it moves `sessionEpoch` only (CEO, 2026-09-24).
   *
   * UNCONDITIONAL increments, on purpose: the plain logout conditions its bump on the epoch the guard read
   * (so a double click advances it once), but here a concurrent bump of `sessionEpoch` alone (a plain
   * logout from another device) would make such a condition match nothing and leave `mcpCredentialEpoch`
   * unmoved — the AI apps would survive the very action meant to cut them off. A repeat bumps again, which
   * is harmless. No password step-up: like every other revocation in lazyit (sign-out, ending a device,
   * revoking a connection) it only removes access, and step-up is unavailable outside local mode.
   */
  async signOutEverywhere(
    user: Pick<User, 'id'>,
    ip: string | null,
  ): Promise<void> {
    const ended = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          sessionEpoch: { increment: 1 },
          mcpCredentialEpoch: { increment: 1 },
        },
        select: { id: true },
      });
      const count = await this.sessions.endAll(user.id, tx);
      await this.audit.record(
        {
          action: 'SIGNED_OUT_EVERYWHERE',
          userId: user.id,
          actorId: user.id,
          ip,
          detail: { authMode: process.env.AUTH_MODE ?? null },
        },
        tx,
      );
      return count;
    });
    this.logger.log(
      `signed out everywhere user=${user.id} sessionRowsEnded=${ended}`,
    );
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
