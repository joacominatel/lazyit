import { Injectable } from '@nestjs/common';
import type { OAuthAuditAction } from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** One `oauth_audit_log` row. `detail` holds scopes, hosts and reasons — NEVER a token, code or secret. */
export interface OAuthAuditEntry {
  action: OAuthAuditAction;
  /** The subject user. */
  userId?: string | null;
  /** Who acted — the user or an admin; null for protocol events. */
  actorId?: string | null;
  grantId?: string | null;
  /** `OAuthClient.clientId` (a string, so the row survives client garbage collection). */
  clientId?: string | null;
  ip?: string | null;
  detail?: Prisma.InputJsonValue;
}

type AuditWriter =
  | Pick<PrismaService, 'oAuthAuditLog'>
  | Prisma.TransactionClient;

/**
 * The authorization server's append-only security trail (ADR-0081 source `oauth`). Only `create` is
 * ever called on the table; nothing updates or deletes it. Pass the transaction client to record an
 * event atomically with the change it describes.
 */
@Injectable()
export class OAuthAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: OAuthAuditEntry, tx?: AuditWriter): Promise<void> {
    const writer = tx ?? this.prisma;
    await writer.oAuthAuditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        actorId: entry.actorId ?? null,
        grantId: entry.grantId ?? null,
        clientId: entry.clientId ?? null,
        ip: entry.ip ?? null,
        detail: entry.detail,
      },
    });
  }
}
