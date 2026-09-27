jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkflowConnectionsService } from './workflow-connections.service';
import { UpdateWorkflowConnectionApiSchema } from './workflow.dto';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Principal } from '../../auth/principal';
import type { ConnectorRegistry } from '../connectors.registry';
import type { SecretService } from '../secrets/secret.service';

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
  // The registry + secret store are only exercised by `test()` (a separate spec); the CSEC-1 SoD path
  // never touches them, so stub them out here.
  const registry = {} as unknown as ConnectorRegistry;
  const secrets = {} as unknown as SecretService;
  const service = new WorkflowConnectionsService(
    prisma,
    resolver,
    registry,
    secrets,
  );
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

/**
 * SEC-075 — `defaultHeaders` may hold a pasted credential (`Authorization: Bearer …`) on a connection
 * with `secretId: null`. They are gated like a credential (CSEC-1) and redacted on every read; a
 * redacted value sent back on a PATCH keeps the stored value.
 */
describe('WorkflowConnectionsService — SEC-075 default headers', () => {
  const TOKEN = 'Bearer sk_live_123';
  const withHeaders = {
    ...noSecret,
    config: {
      kind: 'REST' as const,
      baseUrl: 'https://jira.example.com',
      authScheme: 'NONE' as const,
      defaultHeaders: { Authorization: TOKEN, Accept: 'application/json' },
    },
  };
  const restWith = (
    baseUrl: string,
    defaultHeaders: Record<string, string>,
  ) => ({
    kind: 'REST' as const,
    baseUrl,
    authScheme: 'NONE' as const,
    defaultHeaders,
  });
  type UpdateCall = [
    { data: { config?: { defaultHeaders?: Record<string, string> } } },
  ];

  it('a manage-only principal cannot RE-POINT a secretId:null connection that carries headers (403)', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await expect(
      h.service.update(
        'c1',
        {
          config: restWith('https://attacker.example', {
            Authorization: '[redacted]',
            Accept: '[redacted]',
          }),
        },
        manageOnly,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.workflowConnection.update).not.toHaveBeenCalled();
  });

  it('a manage-only principal cannot re-point with the header values typed back in (403)', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await expect(
      h.service.update(
        'c1',
        {
          config: restWith('https://attacker.example', {
            Authorization: TOKEN,
            Accept: 'application/json',
          }),
        },
        manageOnly,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a manage-only principal cannot add or change a header value (403)', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await expect(
      h.service.update(
        'c1',
        {
          config: restWith('https://jira.example.com', {
            Authorization: 'Bearer other',
            Accept: '[redacted]',
          }),
        },
        manageOnly,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.workflowConnection.update).not.toHaveBeenCalled();
  });

  it('a manage-only principal may REMOVE the headers on the same host (removal cannot exfiltrate)', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await h.service.update(
      'c1',
      { config: REST('https://jira.example.com') },
      manageOnly,
    );
    expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
  });

  it('a manage-only principal may round-trip the redacted read unchanged, keeping the stored values', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await h.service.update(
      'c1',
      {
        name: 'Renamed',
        config: restWith('https://jira.example.com', {
          Authorization: '[redacted]',
          Accept: '[redacted]',
        }),
      },
      manageOnly,
    );

    const data = (h.workflowConnection.update.mock.calls as UpdateCall[])[0][0]
      .data;
    expect(data.config?.defaultHeaders).toEqual({
      Authorization: TOKEN,
      Accept: 'application/json',
    });
  });

  it('a workflow:secrets holder may re-point and change header values', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await h.service.update(
      'c1',
      {
        config: restWith('https://moved.example.com', {
          Authorization: 'Bearer rotated',
        }),
      },
      secretsHolder,
    );
    expect(h.workflowConnection.update).toHaveBeenCalledTimes(1);
  });

  it('a redacted value for a header that is not stored is a 400', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(withHeaders);

    await expect(
      h.service.update(
        'c1',
        {
          config: restWith('https://jira.example.com', {
            'X-New': '[redacted]',
          }),
        },
        secretsHolder,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('findOne and findPage return header VALUES and URL userinfo redacted (names kept)', async () => {
    const h = build();
    const legacy = {
      ...withHeaders,
      config: {
        ...withHeaders.config,
        baseUrl: 'https://svc:hunter2@jira.example.com/api',
      },
    };
    h.workflowConnection.findFirst.mockResolvedValue(legacy);

    const one = await h.service.findOne('c1');
    expect(one.config).toEqual({
      kind: 'REST',
      baseUrl: 'https://[redacted]@jira.example.com/api',
      authScheme: 'NONE',
      defaultHeaders: { Authorization: '[redacted]', Accept: '[redacted]' },
    });
    expect(JSON.stringify(one)).not.toContain('sk_live');
    expect(JSON.stringify(one)).not.toContain('hunter2');
    // SEC-076: the legacy row is flagged (additive) so the UI can warn; it is not rewritten.
    expect(one.legacyUserinfo).toBe(true);

    const prisma = h.workflowConnection as unknown as {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    prisma.findMany = jest.fn().mockResolvedValue([legacy]);
    prisma.count = jest.fn().mockResolvedValue(1);
    (
      h.service as unknown as {
        prisma: { $transaction: (ops: Promise<unknown>[]) => unknown };
      }
    ).prisma.$transaction = (ops) => Promise.all(ops);
    const page = await h.service.findPage(undefined, {
      limit: 10,
      offset: 0,
    } as never);
    expect(JSON.stringify(page)).not.toContain('sk_live');
    expect(JSON.stringify(page)).not.toContain('hunter2');
  });
});

describe('SEC-076 — userinfo is refused on edit (write-only), a clean row is not flagged', () => {
  it('the PATCH DTO refuses a config whose URL carries userinfo', () => {
    expect(
      UpdateWorkflowConnectionApiSchema.safeParse({
        config: REST('https://u:p@jira.example.com'),
      }).success,
    ).toBe(false);
    expect(
      UpdateWorkflowConnectionApiSchema.safeParse({
        config: REST('https://jira.example.com'),
      }).success,
    ).toBe(true);
    // A rename alone never trips the check.
    expect(
      UpdateWorkflowConnectionApiSchema.safeParse({ name: 'x' }).success,
    ).toBe(true);
  });

  it('a connection without userinfo reads legacyUserinfo: false', async () => {
    const h = build();
    h.workflowConnection.findFirst.mockResolvedValue(noSecret);
    const one = await h.service.findOne('c1');
    expect(one.legacyUserinfo).toBe(false);
  });
});
