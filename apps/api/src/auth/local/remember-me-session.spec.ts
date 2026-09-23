import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';

// Keep the real generated Prisma client and the ESM meilisearch package out of this test: every service
// here runs against the in-memory user row below.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
// jose is ESM-only and only serves the OIDC branch, which this local-mode suite never reaches.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { JwtAuthGuard } from '../jwt-auth.guard';
import { LocalCredentialService } from './local-credential.service';
import { LocalProvisioningService } from './local-provisioning.service';
import { LoginService } from './login.service';
import { PasswordLifecycleService } from './password-lifecycle.service';
import { UsersService } from '../../users/users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchService } from '../../search/search.service';
import { AssetAssignmentsService } from '../../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../../asset-history/asset-history.service';
import { UserHistoryService } from '../../user-history/user-history.service';
import { WorkflowTriggerService } from '../../workflow-engine/run/workflow-trigger.service';
import { AccessGrantsService } from '../../access-grants/access-grants.service';
import { IDENTITY_PROVIDER } from '../identity/identity-provider.interface';

/**
 * "Keep me signed in" end to end (ADR-0086 §8, #1307). A remember-me token never expires by time, so the
 * ONLY things that end it are the guard's per-request checks and a `sessionEpoch` bump. This suite drives
 * the REAL LoginService, PasswordLifecycleService, UsersService and JwtAuthGuard against one in-memory
 * user row — with real HS256 tokens — and proves each revocation path the CEO's decision names actually
 * kills a remember-me session: sign-out, password change, admin reset, deactivation, offboarding.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'Old-password-1!';

interface Row {
  id: string;
  email: string;
  username: string | null;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  directoryOnly: boolean;
  externalId: string | null;
  managerId: string | null;
  managerName: string | null;
  passwordHash: string | null;
  mustChangePassword: boolean;
  sessionEpoch: number;
  deletedAt: Date | null;
}

type Where = {
  id?: string;
  sessionEpoch?: number;
  OR?: Array<{ email?: string; username?: string }>;
};

/** Apply a Prisma-style `data` (including `{ increment }`) to the row. */
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      (row as unknown as Record<string, number>)[key] += (
        value as { increment: number }
      ).increment;
    } else {
      (row as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

describe('remember-me session lifecycle (ADR-0086 §8)', () => {
  const originalMode = process.env.AUTH_MODE;
  let row: Row;
  let prisma: Record<string, unknown>;
  let credentials: LocalCredentialService;
  let login: LoginService;
  let passwords: PasswordLifecycleService;
  let users: UsersService;
  let guard: JwtAuthGuard;

  beforeAll(() => {
    process.env.SESSION_SIGNING_SECRET =
      'test-session-signing-secret-0123456789abcdef';
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(async () => {
    process.env.AUTH_MODE = 'local';
    credentials = new LocalCredentialService();
    row = {
      id: USER_ID,
      email: 'alice@example.com',
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Smith',
      role: 'MEMBER',
      isActive: true,
      directoryOnly: false,
      externalId: null,
      managerId: null,
      managerName: null,
      passwordHash: await credentials.hash(PASSWORD),
      mustChangePassword: false,
      sessionEpoch: 0,
      deletedAt: null,
    };

    // A LIVE-filtered view of the single row, mirroring the soft-delete extension (includeSoftDeleted is
    // the escape hatch restore() uses).
    const matches = (where: Where, includeSoftDeleted = false): boolean => {
      if (!includeSoftDeleted && row.deletedAt !== null) return false;
      if (where.id !== undefined && where.id !== row.id) return false;
      if (
        where.sessionEpoch !== undefined &&
        where.sessionEpoch !== row.sessionEpoch
      )
        return false;
      if (where.OR) {
        return where.OR.some(
          (c) =>
            (c.email !== undefined && c.email === row.email) ||
            (c.username !== undefined && c.username === row.username),
        );
      }
      return true;
    };
    const user = {
      findFirst: jest.fn(
        ({
          where,
          includeSoftDeleted,
        }: {
          where: Where;
          includeSoftDeleted?: boolean;
        }) =>
          Promise.resolve(
            matches(where, includeSoftDeleted) ? { ...row } : null,
          ),
      ),
      update: jest.fn(
        ({ data }: { where: Where; data: Record<string, unknown> }) => {
          applyData(row, data);
          return Promise.resolve({ ...row });
        },
      ),
      updateMany: jest.fn(
        ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          if (!matches(where)) return Promise.resolve({ count: 0 });
          applyData(row, data);
          return Promise.resolve({ count: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      user,
      passwordResetToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      accessGrant: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      vaultMembership: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      secretAuditLog: { createMany: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn(prisma)),
    );

    const history = { record: jest.fn().mockResolvedValue({}) };
    login = new LoginService(prisma as never, credentials);
    passwords = new PasswordLifecycleService(
      prisma as never,
      credentials,
      history as never,
      {} as never,
    );
    guard = new JwtAuthGuard(prisma as never, new Reflector(), credentials);

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SearchService,
          useValue: { upsert: jest.fn(), remove: jest.fn() },
        },
        {
          provide: AssetAssignmentsService,
          useValue: { releaseAllForUser: jest.fn().mockResolvedValue([]) },
        },
        { provide: AssetHistoryService, useValue: {} },
        { provide: UserHistoryService, useValue: history },
        { provide: WorkflowTriggerService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        {
          provide: IDENTITY_PROVIDER,
          useValue: { kind: 'local', supportsManagement: false },
        },
        {
          provide: LocalProvisioningService,
          useValue: new LocalProvisioningService(credentials),
        },
        { provide: PasswordLifecycleService, useValue: passwords },
        {
          provide: getLoggerToken(UsersService.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();
    users = moduleRef.get(UsersService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Run the global guard against a Bearer and return the request it populated. */
  async function authenticate(token: string) {
    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as never;
    await guard.canActivate(ctx);
    return req as {
      user?: Row;
      localSession?: { rememberMe: boolean };
    };
  }

  async function rememberMeLogin(): Promise<string> {
    const res = await login.login('alice@example.com', PASSWORD, true);
    expect(res.expiresAt).toBeNull();
    return res.token;
  }

  it('authenticates a remember-me token and records the session kind on the request', async () => {
    const token = await rememberMeLogin();
    const req = await authenticate(token);
    expect(req.user?.id).toBe(USER_ID);
    expect(req.localSession).toEqual({ rememberMe: true });
  });

  it('a default token is recorded as a non-remember-me session', async () => {
    const { token, expiresAt } = await login.login(
      'alice@example.com',
      PASSWORD,
    );
    expect(typeof expiresAt).toBe('number');
    const req = await authenticate(token);
    expect(req.localSession).toEqual({ rememberMe: false });
  });

  it('outlives the 12h window that kills a default token', async () => {
    const remembered = await rememberMeLogin();
    const { token: shortLived } = await login.login(
      'alice@example.com',
      PASSWORD,
    );
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await expect(authenticate(shortLived)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(authenticate(remembered)).resolves.toMatchObject({
      localSession: { rememberMe: true },
    });
  });

  it('dies on sign-out, and a second sign-out with the same token changes nothing', async () => {
    const token = await rememberMeLogin();
    const req = await authenticate(token);

    await login.logout(req.user as never);
    expect(row.sessionEpoch).toBe(1);
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);

    // A stale caller (e.g. a concurrent sign-out that authenticated before the bump) cannot bump again.
    await login.logout(req.user as never);
    expect(row.sessionEpoch).toBe(1);
  });

  it('sign-out also ends the same user’s other sessions (epoch model)', async () => {
    const laptop = await rememberMeLogin();
    const phone = await rememberMeLogin();
    const req = await authenticate(phone);
    await login.logout(req.user as never);
    await expect(authenticate(laptop)).rejects.toThrow(UnauthorizedException);
  });

  it('dies on a password change, and the re-minted token stays remember-me', async () => {
    const token = await rememberMeLogin();
    const req = await authenticate(token);

    const res = await passwords.changePassword(
      req.user as never,
      PASSWORD,
      'New-password-2!',
      req.localSession?.rememberMe === true,
    );

    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
    expect(res.expiresAt).toBeNull();
    await expect(authenticate(res.token)).resolves.toMatchObject({
      localSession: { rememberMe: true },
    });
  });

  it('dies on an admin temporary-password reset', async () => {
    const token = await rememberMeLogin();
    await users.requestPasswordReset(USER_ID, ADMIN_ID, {
      delivery: 'temporary-password',
    });
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
  });

  it('dies on deactivation and does NOT come back on reactivation', async () => {
    const token = await rememberMeLogin();
    await users.update(USER_ID, { isActive: false }, ADMIN_ID);
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);

    await users.update(USER_ID, { isActive: true }, ADMIN_ID);
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
  });

  it('dies on offboarding and does NOT come back on restore', async () => {
    const token = await rememberMeLogin();
    await users.remove(USER_ID, { userId: ADMIN_ID });
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);

    await users.restore(USER_ID, { userId: ADMIN_ID });
    expect(row.deletedAt).toBeNull();
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
  });

  it('is refused for a directory-only row', async () => {
    const token = await rememberMeLogin();
    row.directoryOnly = true;
    await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
  });
});
