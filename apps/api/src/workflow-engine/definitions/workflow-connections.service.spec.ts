jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { ForbiddenException } from '@nestjs/common';
import { WorkflowConnectionsService } from './workflow-connections.service';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Principal } from '../../auth/principal';

/**
 * CSEC-1 — manage/secrets Separation of Duties on the connection PATCH. `workflow:manage` configures
 * the engine, but ATTACHING/CHANGING a connection's credential reference, or RE-POINTING the host of a
 * connection that bears a secret, would let a manage-only principal exfiltrate a same-app secret (the
 * engine sends the revealed BEARER credential to whatever host the config names). Those two moves
 * additionally require `workflow:secrets`. Both perms are ADMIN-by-default, so the default admin path
 * is unchanged. Exercised at the service layer for BOTH principal kinds (ADR-0048).
 */

const APP = 'app_cuid_1';
const SECRET = 'sec_cuid_1';

const REST = (baseUrl: string) => ({
  kind: 'REST' as const,
  baseUrl,
  authScheme: 'BEARER' as const,
});

// Service-account principals carry an explicit direct-grant permission set (no role).
const manageOnly: Principal = {
  kind: 'service',
  serviceAccount: { id: 'sa_manage' },
  permissions: new Set(['workflow:manage']),
} as unknown as Principal;
const secretsHolder: Principal = {
  kind: 'service',
  serviceAccount: { id: 'sa_secrets' },
  permissions: new Set(['workflow:manage', 'workflow:secrets']),
} as unknown as Principal;
// A human ADMIN resolves to the full catalog via PermissionResolverService (default-ADMIN works).
const adminHuman: Principal = {
  kind: 'human',
  user: { id: 'u1', role: 'ADMIN' },
} as unknown as Principal;

function build() {
  const workflowConnection = {
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const workflowSecret = {
    findFirst: jest.fn().mockResolvedValue({ applicationId: APP }),
  };
  const rolePermission = { findMany: jest.fn() };
  const prisma = {
    workflowConnection,
    workflowSecret,
    rolePermission,
  } as unknown as PrismaService;
  const resolver = new PermissionResolverService(prisma);
  const service = new WorkflowConnectionsService(prisma, resolver);
  return { service, workflowConnection, workflowSecret, rolePermission };
}

const secretBearing = {
  id: 'c1',
  applicationId: APP,
  kind: 'REST',
  config: REST('https://jira.example.com'),
  secretId: SECRET,
  deletedAt: null,
};
const noSecret = { ...secretBearing, secretId: null };

describe('WorkflowConnectionsService.update — CSEC-1 SoD gate', () => {
  describe('a manage-only principal is BLOCKED (403)', () => {
    it('cannot ATTACH a secretId', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(noSecret);

      await expect(
        h.service.update('c1', { secretId: SECRET }, manageOnly),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.workflowConnection.update).not.toHaveBeenCalled();
    });

    it('cannot RE-POINT the host of a secret-bearing connection', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(secretBearing);

      await expect(
        h.service.update(
          'c1',
          { config: REST('https://attacker.example.com') },
          manageOnly,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.workflowConnection.update).not.toHaveBeenCalled();
    });
  });

  describe('a manage-only principal is ALLOWED for non-exfiltrating edits', () => {
    it('can rename (no secret / no host change)', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(secretBearing);

      await h.service.update('c1', { name: 'Renamed' }, manageOnly);

      expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
    });

    it('can change the host of a connection that bears NO secret', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(noSecret);

      await h.service.update(
        'c1',
        { config: REST('https://new.example.com') },
        manageOnly,
      );

      expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
    });

    it('can CLEAR the credential (secretId: null) — clearing cannot exfiltrate', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(secretBearing);

      await h.service.update('c1', { secretId: null }, manageOnly);

      expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
      // Clearing never validates a secret reference.
      expect(h.workflowSecret.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('a workflow:secrets holder is ALLOWED', () => {
    it('can attach a secretId (same-app secret validated)', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(noSecret);

      await h.service.update('c1', { secretId: SECRET }, secretsHolder);

      expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
      expect(h.workflowSecret.findFirst).toHaveBeenCalledTimes(1);
    });

    it('can re-point the host of a secret-bearing connection', async () => {
      const h = build();
      h.workflowConnection.findFirst.mockResolvedValue(secretBearing);

      await h.service.update(
        'c1',
        { config: REST('https://moved.example.com') },
        secretsHolder,
      );

      expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
    });
  });

  it('default-ADMIN (human) still works: an ADMIN may attach a secret', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(noSecret);

    await h.service.update('c1', { secretId: SECRET }, adminHuman);

    expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
    // ADMIN short-circuits to the full catalog — never a DB role lookup.
    expect(h.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('an anonymous caller (no principal) is fail-closed on a secret attach', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(noSecret);

    await expect(
      h.service.update('c1', { secretId: SECRET }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.workflowConnection.update).not.toHaveBeenCalled();
  });
});
