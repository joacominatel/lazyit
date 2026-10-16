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
 * Once per connection: the unique `dedupeKey` makes a racing second emit a no-op, and `announcedAt` and
 * the memo are set only once the notice row exists, so a failed send is retried (AUD-014).
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
    // A notice row without the stamp: sent before the column existed, or by an older replica.
    const already = await this.sentAt(dedupeKey);
    if (!already) {
      const personal = caller.kind === 'personal';
      const name =
        grant.clientName?.trim() ||
        (personal ? 'A personal token' : 'An unnamed client');
      const access = grant.scopes.includes('lazyit.write')
        ? 'read and write'
        : 'read-only';
      // A concurrent emit loses on the unique dedupeKey (no row, no email) and finds the winner's row here.
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
      if (id === null && (await this.sentAt(dedupeKey)) === null) return true;
    }
    await this.prisma.oAuthGrant.updateMany({
      where: { id: grant.id, announcedAt: null },
      data: { announcedAt: already ?? now },
    });
    this.remember(grant.id);
    return !already;
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
