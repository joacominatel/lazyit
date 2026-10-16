import { Injectable, Logger } from '@nestjs/common';
import { formatOAuthScopes } from '@lazyit/shared';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { McpCaller } from './mcp-caller';

/** How many grants this process remembers as already announced (a bounded memo; the DB key is the truth). */
const MEMO_LIMIT = 10_000;

/**
 * "A new AI agent was connected to your account" (security.md §6.3 "User notice"; gate G3 "Abuse"): a
 * TARGETED bell notification — also emailed when SMTP is configured — sent to the account's owner the
 * FIRST time a connection (an OAuth grant, or a personal token) is used at `/mcp`. Local mode has no MFA,
 * so a phished consent or a token minted from a stolen session must not go unnoticed.
 *
 * Exactly once per connection: the notification's `dedupeKey` is `mcp.client_connected:<grantId>`
 * (UNIQUE — a second emit, on any replica, is a quiet no-op), and a per-process memo — set only once the
 * notice exists, so a failed send is retried — spares the lookups on every later request. The email copy
 * follows the owner's per-type email opt-out like every emailable type (the allowlist has no mandatory
 * types); the bell copy always lands. Whether a connection was announced is stored on the grant
 * (`announcedAt`), never inferred from its age, so the 90-day bell prune cannot make an old, never-announced
 * grant look announced (AUD-014). A grant announced before the column existed is recognized by its notice
 * row and the column is filled in. Two concurrent first uses claim `announcedAt` with a conditional update,
 * so only one of them sends. Service Accounts have no bell and are never announced.
 *
 * Best-effort and fire-and-forget: a notification problem never fails or delays the MCP request.
 */
@Injectable()
export class McpConnectionNoticeService {
  private readonly logger = new Logger(McpConnectionNoticeService.name);
  private readonly announced = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Announce the caller's connection if this is its first use. Never throws, never awaits the caller. */
  noticeFirstUse(caller: McpCaller): void {
    void this.announce(caller).catch((err: unknown) => {
      this.logger.warn(
        `Could not send the new-connection notice for grant ${caller.grant?.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** The awaited form (tests). Returns whether an emit was attempted. */
  async announce(caller: McpCaller, now: Date = new Date()): Promise<boolean> {
    const grant = caller.grant;
    if (!grant || caller.identity.kind !== 'human') return false;
    if (this.announced.has(grant.id)) return false;
    const dedupeKey = `mcp.client_connected:${grant.id}`;

    const row = await this.prisma.oAuthGrant.findFirst({
      where: { id: grant.id },
      select: { userId: true, announcedAt: true },
    });
    if (!row || row.announcedAt !== null) {
      this.remember(grant.id);
      return false;
    }
    // Announced before `announcedAt` existed (or by an older replica): record it and stop.
    const sentAt = await this.sentAt(dedupeKey);
    if (sentAt) {
      await this.prisma.oAuthGrant.updateMany({
        where: { id: grant.id, announcedAt: null },
        data: { announcedAt: sentAt },
      });
      this.remember(grant.id);
      return false;
    }
    const { count } = await this.prisma.oAuthGrant.updateMany({
      where: { id: grant.id, announcedAt: null },
      data: { announcedAt: now },
    });
    // A concurrent first use claimed it; not remembered, so a failed send over there is retried here.
    if (count === 0) return false;

    const personal = caller.kind === 'personal';
    const name =
      grant.clientName?.trim() ||
      (personal ? 'A personal token' : 'An unnamed client');
    const access = grant.scopes.includes('lazyit.write')
      ? 'read and write'
      : 'read-only';
    let sent = false;
    try {
      const id = await this.notifications.emit({
        type: 'mcp.client_connected',
        dedupeKey,
        severity: 'warning',
        recipientUserId: row.userId,
        targetUserId: row.userId,
        title: personal
          ? `Personal token "${name}" was used to connect an AI agent`
          : `${name} was connected to your lazyit account`,
        summary:
          `An external AI agent now has ${access} access to lazyit as you` +
          `${grant.scopes.includes('lazyit.admin') ? ', including admin actions' : ''}. ` +
          `If this wasn't you, revoke it in Account → AI connections and change your password.`,
        metadata: {
          grantId: grant.id,
          kind: personal ? 'personal' : 'oauth',
          clientName: grant.clientName,
          scopes: formatOAuthScopes(grant.scopes),
        },
      });
      // `emit` swallows its failures and answers null; a null because the dedupe key already exists is a send.
      sent = id !== null || (await this.sentAt(dedupeKey)) !== null;
    } finally {
      if (sent) {
        this.remember(grant.id);
      } else {
        // Release the claim so the connection's next request retries the send (G3 review F5).
        await this.prisma.oAuthGrant.updateMany({
          where: { id: grant.id, announcedAt: now },
          data: { announcedAt: null },
        });
      }
    }
    return true;
  }

  private async sentAt(dedupeKey: string): Promise<Date | null> {
    const existing = await this.prisma.notification.findUnique({
      where: { dedupeKey },
      select: { createdAt: true },
    });
    return existing?.createdAt ?? null;
  }

  private remember(grantId: string): void {
    if (this.announced.size >= MEMO_LIMIT) this.announced.clear();
    this.announced.add(grantId);
  }
}
