import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
  AiServiceAccountAccessSchema,
  type AiServiceAccountSettings,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `AiConfigAuditLog.action` for a per-Service-Account AI access change. `detail` is `{ before, after }`
 * of the two fields — nothing else, and never a credential.
 */
export const AI_SA_ACCESS_AUDIT_ACTION = 'service_account.ai_access.updated';

/**
 * The per-Service-Account AI access setting (CEO round 2; ADR-0097 decision 4; synthesis §6
 * `ai_service_account_settings`): `off` | `read-only` | `read-write` plus an optional cap on executed writes
 * per headless run. The runtime reads it before every step (`AiRunPrincipals`), so a change applies at
 * the next step boundary of a running run.
 *
 * No row reads as `read-write` without a cap — exactly how every Service Account behaved before the row
 * existed. Read-tolerant but restrictive, like the runtime: a stored `access` this build does not know
 * reads as `read-only`, a malformed cap as none. Only a revoked (soft-deleted) or unknown account is 404.
 */
@Injectable()
export class AiServiceAccountAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async get(serviceAccountId: string): Promise<AiServiceAccountSettings> {
    await this.requireAccount(serviceAccountId);
    return this.read(serviceAccountId);
  }

  /**
   * Replace the setting, audited with its author in the same transaction. An unchanged value writes
   * nothing (no row, no audit), like `PUT /config/ai`.
   */
  async update(
    serviceAccountId: string,
    next: AiServiceAccountSettings,
    actorId: string | null,
  ): Promise<AiServiceAccountSettings> {
    await this.requireAccount(serviceAccountId);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.read(serviceAccountId, tx);
      if (
        before.access === next.access &&
        before.maxMutationsPerRun === next.maxMutationsPerRun
      ) {
        return before;
      }
      await tx.aiServiceAccountSettings.upsert({
        where: { serviceAccountId },
        create: {
          serviceAccountId,
          access: next.access,
          maxMutationsPerRun: next.maxMutationsPerRun,
        },
        update: {
          access: next.access,
          maxMutationsPerRun: next.maxMutationsPerRun,
        },
      });
      await tx.aiConfigAuditLog.create({
        data: {
          action: AI_SA_ACCESS_AUDIT_ACTION,
          actorId,
          targetServiceAccountId: serviceAccountId,
          detail: {
            before: {
              access: before.access,
              maxMutationsPerRun: before.maxMutationsPerRun,
            },
            after: {
              access: next.access,
              maxMutationsPerRun: next.maxMutationsPerRun,
            },
          },
        },
      });
      return {
        access: next.access,
        maxMutationsPerRun: next.maxMutationsPerRun,
      };
    });
  }

  /** A live Service Account (the soft-delete extension hides revoked ones), else 404. */
  private async requireAccount(serviceAccountId: string): Promise<void> {
    const account = await this.prisma.serviceAccount.findUnique({
      where: { id: serviceAccountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Service account not found',
      });
    }
  }

  private async read(
    serviceAccountId: string,
    client: Pick<PrismaService, 'aiServiceAccountSettings'> = this.prisma,
  ): Promise<AiServiceAccountSettings> {
    const row = await client.aiServiceAccountSettings.findUnique({
      where: { serviceAccountId },
    });
    if (!row) {
      return {
        access: AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
        maxMutationsPerRun: null,
      };
    }
    const access = AiServiceAccountAccessSchema.safeParse(row.access);
    const cap = row.maxMutationsPerRun;
    return {
      access: access.success ? access.data : 'read-only',
      maxMutationsPerRun:
        typeof cap === 'number' && Number.isInteger(cap) && cap >= 1
          ? cap
          : null,
    };
  }
}
