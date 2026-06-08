import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The dedicated, least-privilege engine ServiceAccount a workflow EXECUTES AS (ADR-0048 / ADR-0054 §6 +
 * priority 6). It is the audited PRINCIPAL pinned onto every run (`WorkflowRun.executedAsServiceAccountId`,
 * copied from `ApplicationWorkflow.executedAsServiceAccountId`) so a run's lazyit-side effects are
 * attributed to a non-human, non-ADMIN identity — never a fabricated human (INV-SA-2/4).
 *
 * It holds NO permission grants on purpose: v1 connectors only call OUT through the egress guard; the
 * engine never re-enters lazyit's own API as this principal, so least privilege = zero grants. Its token
 * is a throwaway (it never authenticates), so we store a random hash and never mint/return a usable
 * secret. Auto-provisioned idempotently by the reserved name.
 */
@Injectable()
export class EngineServiceAccountService {
  private readonly logger = new Logger(EngineServiceAccountService.name);
  /** Reserved, recognisable display name used to find/replace the singleton engine SA. */
  static readonly ENGINE_SA_NAME = 'lazyit-workflow-engine';
  private cachedId: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return the engine SA id, creating it on first use. Idempotent: a concurrent create is absorbed by
   * re-reading. The result is cached for the process lifetime (the row is never hard-deleted).
   */
  async getOrCreate(): Promise<string> {
    if (this.cachedId) {
      return this.cachedId;
    }
    const existing = await this.prisma.serviceAccount.findFirst({
      where: {
        name: EngineServiceAccountService.ENGINE_SA_NAME,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      this.cachedId = existing.id;
      return existing.id;
    }
    try {
      const created = await this.prisma.serviceAccount.create({
        data: {
          name: EngineServiceAccountService.ENGINE_SA_NAME,
          description:
            'Least-privilege engine identity workflows execute as (auto-provisioned, no grants).',
          // A throwaway hash: this SA never authenticates (it is an attribution principal only).
          tokenHash: randomBytes(32).toString('hex'),
          tokenPrefix: '',
          isActive: true,
        },
        select: { id: true },
      });
      this.cachedId = created.id;
      this.logger.log(
        'Provisioned the least-privilege engine service account.',
      );
      return created.id;
    } catch {
      // Lost a create race — re-read the winner.
      const winner = await this.prisma.serviceAccount.findFirst({
        where: {
          name: EngineServiceAccountService.ENGINE_SA_NAME,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!winner) {
        throw new Error('Failed to provision the engine service account');
      }
      this.cachedId = winner.id;
      return winner.id;
    }
  }
}
