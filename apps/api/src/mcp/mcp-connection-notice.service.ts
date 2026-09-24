import { Injectable, Logger } from '@nestjs/common';
import { formatOAuthScopes } from '@lazyit/shared';
import { NOTIFICATION_RETENTION_MS } from '../notifications/notifications-retention.sweeper';
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
 * (UNIQUE — a second emit, on any replica, is a quiet no-op), and a per-process memo spares the insert
 * attempt on every later request. The bell forgets after 90 days, so a grant is announced only while it
 * is younger than that: an older grant's notice, if any, was already sent and may have been pruned, and
 * must not be re-sent. Service Accounts have no bell and are never announced.
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
    this.remember(grant.id);

    const row = await this.prisma.oAuthGrant.findFirst({
      where: { id: grant.id },
      select: { createdAt: true, userId: true },
    });
    if (
      !row ||
      now.getTime() - row.createdAt.getTime() >= NOTIFICATION_RETENTION_MS
    ) {
      return false;
    }

    const personal = caller.kind === 'personal';
    const name =
      grant.clientName?.trim() ||
      (personal ? 'A personal token' : 'An unnamed client');
    const access = grant.scopes.includes('lazyit.write')
      ? 'read and write'
      : 'read-only';
    await this.notifications.emit({
      type: 'mcp.client_connected',
      dedupeKey: `mcp.client_connected:${grant.id}`,
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
    return true;
  }

  private remember(grantId: string): void {
    if (this.announced.size >= MEMO_LIMIT) this.announced.clear();
    this.announced.add(grantId);
  }
}
