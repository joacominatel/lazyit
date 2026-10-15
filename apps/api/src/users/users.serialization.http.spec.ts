import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { getLoggerToken } from 'nestjs-pino';
import request from 'supertest';
import { UserSchema } from '@lazyit/shared';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PUBLIC_USER_SELECT } from './public-user';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { UserHistoryService } from '../user-history/user-history.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
import { PasswordLifecycleService } from '../auth/local/password-lifecycle.service';
import { ActorService } from '../common/actor.service';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * SEC-085 — the User wire shape must never carry a credential or internal column. The rows below are
 * what Prisma returns for a whole-row `findFirst`/`findMany` (every scalar column), and the assertions
 * run on the real HTTP body the real UsersController + UsersService emit.
 */
const FORBIDDEN = [
  'passwordHash',
  'passwordUpdatedAt',
  'sessionEpoch',
  'mcpCredentialEpoch',
  'mustChangePassword',
  'notificationEmailOptOutTypes',
  'directorySourceId',
  'directoryOffboardedAt',
  'directoryReenabledAt',
  'managerId',
  'managerName',
] as const;

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@lazyit.local',
  firstName: 'Ada',
  lastName: 'Lovelace',
  isActive: true,
  role: 'MEMBER',
  externalId: null,
  legajo: null,
  username: null,
  managerId: null,
  managerName: 'HR Person',
  directoryOnly: false,
  directoryAttrs: null,
  directorySource: null,
  directorySourceId: 'guid-1',
  directoryOffboardedAt: null,
  directoryReenabledAt: new Date('2026-01-03T00:00:00Z'),
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
  passwordUpdatedAt: new Date('2026-01-01T00:00:00Z'),
  sessionEpoch: 7,
  mcpCredentialEpoch: 3,
  mustChangePassword: false,
  notificationEmailOptOutTypes: ['asset_assigned'],
  locale: 'en',
  theme: 'dark',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  deletedAt: null,
};

@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: unknown;
      principal?: unknown;
    }>();
    // The guard hands the controller the WHOLE row, exactly like JwtAuthGuard does.
    req.user = ROW;
    req.principal = { kind: 'human', user: ROW };
    return true;
  }
}

function expectNoCredentialColumns(body: Record<string, unknown>) {
  for (const key of FORBIDDEN) {
    expect(body).not.toHaveProperty(key);
  }
  // Every key on the wire is a declared UserSchema field (+ the list-only activity counts).
  const allowed = new Set([
    ...Object.keys(UserSchema.shape),
    'assetsInPossession',
    'appAccesses',
  ]);
  for (const key of Object.keys(body)) {
    expect(allowed.has(key) ? key : `undeclared:${key}`).toBe(key);
  }
}

describe('User wire shape never carries credential columns (SEC-085)', () => {
  let app: INestApplication;
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    assetAssignment: { groupBy: jest.fn() },
    accessGrant: { groupBy: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: {} },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: AssetHistoryService, useValue: {} },
        { provide: UserHistoryService, useValue: {} },
        { provide: WorkflowTriggerService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        { provide: LocalProvisioningService, useValue: {} },
        { provide: PasswordLifecycleService, useValue: {} },
        { provide: getLoggerToken(UsersService.name), useValue: {} },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn(), resolveActor: jest.fn() },
        },
        {
          provide: VaultSetupNudgeService,
          useValue: { notifyIfVaultSetupNeeded: jest.fn() },
        },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.user.findFirst.mockResolvedValue(ROW);
    prisma.user.findMany.mockResolvedValue([ROW]);
    prisma.user.count.mockResolvedValue(1);
    prisma.assetAssignment.groupBy.mockResolvedValue([]);
    prisma.accessGrant.groupBy.mockResolvedValue([]);
  });

  it('GET /users — no list item carries a credential column', async () => {
    const res = await request(app.getHttpServer()).get('/users');
    expect(res.status).toBe(200);
    const body = res.body as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expectNoCredentialColumns(body.items[0]);
    // The contract fields are still there.
    expect(body.items[0]).toMatchObject({
      id: ROW.id,
      email: ROW.email,
      manager: { type: 'external', name: 'HR Person' },
      locale: 'en',
      theme: 'dark',
      assetsInPossession: 0,
      appAccesses: 0,
    });
  });

  it('GET /users/:id — the body carries no credential column', async () => {
    const res = await request(app.getHttpServer()).get(`/users/${ROW.id}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expectNoCredentialColumns(body);
    expect(body.id).toBe(ROW.id);
  });

  it('GET /users/me — the self-read carries no credential column', async () => {
    const res = await request(app.getHttpServer()).get('/users/me');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expectNoCredentialColumns(body);
    expect(body).toMatchObject({ id: ROW.id, role: 'MEMBER' });
  });

  it('PUBLIC_USER_SELECT only names UserSchema fields and no credential column', () => {
    const declared = new Set(Object.keys(UserSchema.shape));
    for (const key of Object.keys(PUBLIC_USER_SELECT)) {
      expect(declared.has(key) ? key : `undeclared:${key}`).toBe(key);
    }
    for (const key of FORBIDDEN) {
      expect(PUBLIC_USER_SELECT).not.toHaveProperty(key);
    }
  });
});
