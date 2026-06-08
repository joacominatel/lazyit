jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { BadRequestException } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../../common/actor.service';
import type { EngineServiceAccountService } from '../engine-service-account.service';
import type { CreateApplicationWorkflow } from '@lazyit/shared';

/** The header-create call shape, so assertions on the persisted executor stay type-safe (no-unsafe-*). */
type CreateCall = [{ data: { executedAsServiceAccountId?: string | null } }];

/**
 * CSEC-3 — `executedAsServiceAccountId` must be the dedicated, least-privilege engine ServiceAccount
 * (ADR-0048 / ADR-0054 §6). A run executes AS — and is audited AS — that principal, so an unvalidated
 * id would let a caller pin ANY ServiceAccount (e.g. a privileged one) onto every run and impersonate
 * it. The service rejects any other non-null id with 400, on both create and update; `undefined`
 * (create defaults it) and `null` (update clears it) pass through.
 */

const APP = 'app_cuid_1';
const ENGINE_SA = 'sa_engine_cuid_000000000';
const OTHER_SA = 'sa_other_cuid_0000000000';

function build() {
  const applicationWorkflow = {
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'wf1' }),
    update: jest.fn().mockResolvedValue({ id: 'wf1' }),
  };
  const application = { findFirst: jest.fn().mockResolvedValue({ id: APP }) };
  const prisma = {
    applicationWorkflow,
    application,
  } as unknown as PrismaService;
  const engineSa = {
    getOrCreate: jest.fn().mockResolvedValue(ENGINE_SA),
  } as unknown as EngineServiceAccountService;
  const service = new WorkflowsService(prisma, new ActorService(), engineSa);
  return { service, applicationWorkflow };
}

const baseCreate: CreateApplicationWorkflow = {
  applicationId: APP,
  trigger: 'ACCESS_GRANTED',
  name: 'WF',
  enabled: false,
  deprovisionPolicy: 'LAST_ACTIVE_GRANT',
};

describe('WorkflowsService — CSEC-3 executor pin-check', () => {
  describe('create', () => {
    it('rejects (400) an executor that is not the engine service account', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue(null); // no existing binding

      await expect(
        h.service.create({
          ...baseCreate,
          executedAsServiceAccountId: OTHER_SA,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.applicationWorkflow.create).not.toHaveBeenCalled();
    });

    it('accepts the engine service account explicitly', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue(null);

      await h.service.create({
        ...baseCreate,
        executedAsServiceAccountId: ENGINE_SA,
      });

      const data = (
        h.applicationWorkflow.create.mock.calls as CreateCall[]
      )[0][0].data;
      expect(data.executedAsServiceAccountId).toBe(ENGINE_SA);
    });

    it('defaults to the engine service account when omitted', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue(null);

      await h.service.create(baseCreate);

      const data = (
        h.applicationWorkflow.create.mock.calls as CreateCall[]
      )[0][0].data;
      expect(data.executedAsServiceAccountId).toBe(ENGINE_SA);
    });
  });

  describe('update', () => {
    it('rejects (400) an executor that is not the engine service account', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue({ id: 'wf1' });

      await expect(
        h.service.update('wf1', {
          executedAsServiceAccountId: OTHER_SA,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.applicationWorkflow.update).not.toHaveBeenCalled();
    });

    it('accepts the engine service account', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue({ id: 'wf1' });

      await h.service.update('wf1', {
        executedAsServiceAccountId: ENGINE_SA,
      });

      expect(h.applicationWorkflow.update).toHaveBeenCalledTimes(1);
    });

    it('accepts null (clears the executor — not an impersonation)', async () => {
      const h = build();
      h.applicationWorkflow.findFirst.mockResolvedValue({ id: 'wf1' });

      await h.service.update('wf1', {
        executedAsServiceAccountId: null,
      });

      expect(h.applicationWorkflow.update).toHaveBeenCalledTimes(1);
    });
  });
});
