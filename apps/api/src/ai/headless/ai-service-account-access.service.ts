import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
  AI_SERVICE_ACCOUNT_ACCESS_LEVELS,
  AiServiceAccountAccessSchema,
  type AiServiceAccountSettings,
  type Permission,
  type Role,
} from '@lazyit/shared';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { assertWithinPermissionCeiling } from '../../service-accounts/permission-ceiling';
import { resolveServiceAccountPermissions } from '../../service-accounts/service-account-permissions';

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
function widens(
  before: AiServiceAccountSettings,
  next: AiServiceAccountSettings,
): boolean {
  const rank = (a: AiServiceAccountSettings['access']) =>
    AI_SERVICE_ACCOUNT_ACCESS_LEVELS.indexOf(a);
  return (
    rank(next.access) > rank(before.access) ||
    (before.maxMutationsPerRun !== null &&
      (next.maxMutationsPerRun === null ||
        next.maxMutationsPerRun > before.maxMutationsPerRun))
  );
}

@Injectable()
export class AiServiceAccountAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rolePermissions: PermissionResolverService,
  ) {}

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
    actorRole?: Role,
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
      // SEC-088: widening puts the account's verbs back to work, so they must fit the caller's own.
      if (actorRole !== 'ADMIN' && widens(before, next)) {
        const held: ReadonlySet<Permission> = actorRole
          ? await this.rolePermissions.resolve(actorRole)
          : new Set();
        const rows = await tx.serviceAccountPermission.findMany({
          where: { serviceAccountId },
          select: { permission: true },
        });
        assertWithinPermissionCeiling(held, [
          ...resolveServiceAccountPermissions(rows),
        ]);
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

  /** A live Service Account, else 404. `findFirst`: the soft-delete extension does not filter `findUnique`. */
  private async requireAccount(serviceAccountId: string): Promise<void> {
    const account = await this.prisma.serviceAccount.findFirst({
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
