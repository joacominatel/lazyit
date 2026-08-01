import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AGENT_POLICY_DEFAULT } from '@lazyit/shared';
import { AgentPolicyService } from './agent-policy.service';
import { PrismaService } from '../prisma/prisma.service';

// The service only ever touches three models and never constructs a Prisma error, so the generated
// client is stubbed to nothing more than the two symbols the module graph needs at import time.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: { __dbNull: true }, JsonNull: { __jsonNull: true } },
}));

type Mock = jest.Mock;

interface PrismaMock {
  agentPolicySettings: { findUnique: Mock; upsert: Mock; update: Mock };
  serviceAccount: { findFirst: Mock; update: Mock };
  infraNode: { findFirst: Mock; update: Mock };
}

const AGENT_SA = {
  kind: 'service',
  serviceAccount: { id: 'sa-agent', agentPolicy: null },
  permissions: new Set(['infra:report']),
} as never;

describe('AgentPolicyService (#1140)', () => {
  let service: AgentPolicyService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      agentPolicySettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ revision: 0, settings: null }),
        update: jest.fn().mockResolvedValue({ revision: 1, settings: null }),
      },
      serviceAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'sa-agent' }),
        update: jest.fn().mockResolvedValue({ id: 'sa-agent' }),
      },
      infraNode: {
        findFirst: jest.fn().mockResolvedValue({ id: 'n-1' }),
        update: jest.fn().mockResolvedValue({ id: 'n-1' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentPolicyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(AgentPolicyService);
  });

  describe('resolveForReport — the three-level resolution behind every ack', () => {
    it('an instance with no settings row at all serves the built-in default (revision 0)', async () => {
      prisma.agentPolicySettings.findUnique.mockResolvedValue(null);
      const policy = await service.resolveForReport(undefined, undefined);
      expect(policy).toEqual(AGENT_POLICY_DEFAULT);
    });

    it('layers node OVER service account OVER instance default', async () => {
      prisma.agentPolicySettings.findUnique.mockResolvedValue({
        revision: 5,
        settings: { intervalSeconds: 1800, collect: { software: false } },
      });
      const policy = await service.resolveForReport(
        { kind: 'service', serviceAccount: { id: 'sa', agentPolicy: { collect: { containers: false } } } } as never,
        { intervalSeconds: 3600 },
      );
      expect(policy.revision).toBe(5);
      expect(policy.intervalSeconds).toBe(3600); // node wins
      expect(policy.collect.software).toBe(false); // instance survives
      expect(policy.collect.containers).toBe(false); // service account survives
      expect(policy.collect.hardware).toBe(true); // built-in default survives
    });

    it('READ-TOLERANT: a stored blob this build cannot parse resolves as "no override"', async () => {
      // Legacy data, a hand-edited row, or a field a NEWER instance wrote before a rollback. None of
      // them may fail a report — the host would vanish from the CMDB, the exact failure ADR-0074's
      // degrade-never-reject posture exists to prevent.
      prisma.agentPolicySettings.findUnique.mockResolvedValue({
        revision: 9,
        settings: { intervalSeconds: 'every-so-often', script: 'rm -rf /' },
      });
      const policy = await service.resolveForReport(AGENT_SA, { collect: 'yes please' });
      expect(policy).toEqual({ ...AGENT_POLICY_DEFAULT, revision: 9 });
    });

    it('a human principal (no service account) simply contributes no middle layer', async () => {
      prisma.agentPolicySettings.findUnique.mockResolvedValue({ revision: 2, settings: {} });
      const policy = await service.resolveForReport(
        { kind: 'human', user: { id: 'u-1' } } as never,
        undefined,
      );
      expect(policy).toEqual({ ...AGENT_POLICY_DEFAULT, revision: 2 });
    });
  });

  describe('the revision counter — ANY write at ANY scope bumps it', () => {
    it('an instance-default write bumps the revision', async () => {
      prisma.agentPolicySettings.upsert.mockResolvedValue({ revision: 4, settings: {} });
      prisma.agentPolicySettings.update.mockResolvedValue({
        revision: 5,
        settings: { intervalSeconds: 600 },
      });
      const result = await service.setInstanceOverride({ intervalSeconds: 600 });
      expect(result.revision).toBe(5);
      const arg = prisma.agentPolicySettings.update.mock.calls[0][0] as {
        data: { revision: { increment: number } };
      };
      expect(arg.data.revision).toEqual({ increment: 1 });
    });

    it('a NODE override write bumps the same instance-wide counter', async () => {
      await service.setNodeOverride('n-1', { collect: { software: false } });
      expect(prisma.infraNode.update).toHaveBeenCalled();
      expect(prisma.agentPolicySettings.update).toHaveBeenCalled();
    });

    it('a SERVICE ACCOUNT override write bumps it too', async () => {
      await service.setServiceAccountOverride('sa-agent', { intervalSeconds: 900 });
      expect(prisma.serviceAccount.update).toHaveBeenCalled();
      expect(prisma.agentPolicySettings.update).toHaveBeenCalled();
    });

    it('CLEARING an override is a write like any other and bumps the counter', async () => {
      await service.setNodeOverride('n-1', null);
      expect(prisma.agentPolicySettings.update).toHaveBeenCalled();
    });
  });

  describe('writes are ENFORCED even though reads are tolerant', () => {
    it('rejects an override carrying a key outside the closed set', async () => {
      await expect(
        service.setInstanceOverride({ script: 'curl evil | sh' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.agentPolicySettings.update).not.toHaveBeenCalled();
    });

    it('rejects a regular expression where a glob belongs', async () => {
      await expect(
        service.setInstanceOverride({ exclude: { nicNames: ['^(a+)+$'] } } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cadence below the fixed tick — the agent physically cannot honour it', async () => {
      await expect(
        service.setInstanceOverride({ intervalSeconds: 30 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s on an unknown node rather than writing an override nothing will ever read', async () => {
      prisma.infraNode.findFirst.mockResolvedValue(null);
      await expect(service.setNodeOverride('nope', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.agentPolicySettings.update).not.toHaveBeenCalled();
    });

    it('404s on an unknown (or revoked) service account', async () => {
      prisma.serviceAccount.findFirst.mockResolvedValue(null);
      await expect(service.setServiceAccountOverride('nope', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
