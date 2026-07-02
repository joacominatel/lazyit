import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { NotificationsService } from '../notifications/notifications.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for the P2002 error class + erased types; the stand-in is defined INSIDE the factory
// (jest.mock is hoisted above module scope) and grabbed back below.
jest.mock('../../generated/prisma/client', () => {
  class KnownRequestError extends Error {
    code: string;
    meta?: { target?: string | string[] };
    constructor(code: string, meta?: { target?: string | string[] }) {
      super(code);
      this.code = code;
      this.meta = meta;
    }
  }
  return {
    PrismaClient: class {},
    Prisma: { PrismaClientKnownRequestError: KnownRequestError },
  };
});

// The mocked error class, for constructing a P2002 the service's `instanceof` check will recognize.
const prismaMock: unknown = jest.requireMock('../../generated/prisma/client');
const FakeKnownRequestError = (
  prismaMock as {
    Prisma: {
      PrismaClientKnownRequestError: new (
        code: string,
        meta?: { target?: string | string[] },
      ) => Error;
    };
  }
).Prisma.PrismaClientKnownRequestError;

const REQUESTER = '11111111-1111-1111-1111-111111111111';
const DECIDER = '22222222-2222-2222-2222-222222222222';
const APP_ID = 'app_cuid_00000000000000001';
const REQ_ID = 'req_cuid_00000000000000001';

const HUMAN_PRINCIPAL = {
  kind: 'human',
  user: { id: DECIDER, role: 'ADMIN' },
} as never;
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: 'sa_abcdefghijklmnopqrstuvwx' },
  permissions: new Set(),
} as never;

type AccessRequestMock = {
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  findMany: jest.Mock;
  create: jest.Mock;
  updateMany: jest.Mock;
  count: jest.Mock;
};

// Concrete `.mock.calls` shapes so assertions stay type-safe (no-unsafe-*), the sibling access-grants
// spec's pattern — cast `mock.calls` to `<Call>[]`, then index `[0][0]`.
type WriteCall = [
  { where?: Record<string, unknown>; data: Record<string, unknown> },
];
type EmitCall = [{ type: string; dedupeKey: string }];
type GrantCall = [Record<string, unknown>];
type FindManyCall = [{ where: unknown }];

describe('AccessRequestsService', () => {
  let service: AccessRequestsService;
  let accessRequest: AccessRequestMock;
  let application: { findFirst: jest.Mock; findUnique: jest.Mock };
  let user: { findUnique: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    accessRequest: AccessRequestMock;
  } & Record<string, unknown>;
  let grants: { createWithinApproval: jest.Mock };
  let notifications: { emit: jest.Mock };

  beforeEach(async () => {
    accessRequest = {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    };
    application = { findFirst: jest.fn(), findUnique: jest.fn() };
    user = { findUnique: jest.fn() };
    prisma = {
      accessRequest,
      application,
      user,
      // findPage uses the array form; the mock awaits each query in the tuple.
      $transaction: jest.fn(
        (arg: Array<Promise<unknown>> | ((tx: unknown) => unknown)) =>
          Array.isArray(arg)
            ? Promise.all(arg)
            : arg({ accessRequest, application, user }),
      ),
    };
    grants = { createWithinApproval: jest.fn() };
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AccessGrantsService, useValue: grants },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(AccessRequestsService);
  });

  describe('create', () => {
    it('creates a PENDING request and emits the access_request.created nudge', async () => {
      application.findFirst.mockResolvedValue({ id: APP_ID });
      accessRequest.findFirst.mockResolvedValue(null); // no existing PENDING
      accessRequest.create.mockResolvedValue({
        id: REQ_ID,
        requesterId: REQUESTER,
        applicationId: APP_ID,
        accessLevel: 'developer',
        status: 'PENDING',
      });
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      user.findUnique.mockResolvedValue({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      const result = await service.create(REQUESTER, {
        applicationId: APP_ID,
        accessLevel: 'developer',
        justification: 'Need it for the migration',
      });

      expect(result.id).toBe(REQ_ID);
      const createArg = (accessRequest.create.mock.calls as WriteCall[])[0][0]
        .data;
      expect(createArg.requesterId).toBe(REQUESTER);
      expect(createArg.applicationId).toBe(APP_ID);
      expect(createArg.accessLevel).toBe('developer');
      // The nudge is best-effort post-commit.
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const emitArg = (notifications.emit.mock.calls as EmitCall[])[0][0];
      expect(emitArg.type).toBe('access_request.created');
      expect(emitArg.dedupeKey).toBe(`access_request.created:${REQ_ID}`);
    });

    it('rejects a second PENDING request for the same (requester, application) with 409', async () => {
      application.findFirst.mockResolvedValue({ id: APP_ID });
      accessRequest.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create(REQUESTER, { applicationId: APP_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(accessRequest.create).not.toHaveBeenCalled();
    });

    it('maps the partial-unique P2002 race to a 409', async () => {
      application.findFirst.mockResolvedValue({ id: APP_ID });
      accessRequest.findFirst.mockResolvedValue(null);
      accessRequest.create.mockRejectedValue(
        new FakeKnownRequestError('P2002', {
          target: 'access_requests_requester_application_pending_key',
        }),
      );

      await expect(
        service.create(REQUESTER, { applicationId: APP_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('400s when the application is not live', async () => {
      application.findFirst.mockResolvedValue(null);

      await expect(
        service.create(REQUESTER, { applicationId: APP_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accessRequest.create).not.toHaveBeenCalled();
    });

    it('does not let a failed nudge break the committed request', async () => {
      application.findFirst.mockResolvedValue({ id: APP_ID });
      accessRequest.findFirst.mockResolvedValue(null);
      accessRequest.create.mockResolvedValue({
        id: REQ_ID,
        requesterId: REQUESTER,
        applicationId: APP_ID,
        accessLevel: null,
        status: 'PENDING',
      });
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      user.findUnique.mockResolvedValue({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      notifications.emit.mockRejectedValue(new Error('bell down'));

      await expect(
        service.create(REQUESTER, { applicationId: APP_ID }),
      ).resolves.toMatchObject({ id: REQ_ID });
    });
  });

  describe('approve', () => {
    it('creates the grant through the grant path + flips the request to APPROVED atomically', async () => {
      accessRequest.findUnique
        .mockResolvedValueOnce({
          id: REQ_ID,
          requesterId: REQUESTER,
          applicationId: APP_ID,
          accessLevel: 'admin',
          status: 'PENDING',
        }) // findPending
        .mockResolvedValueOnce({
          id: REQ_ID,
          status: 'APPROVED',
          grantId: 'grant_new',
          decidedById: DECIDER,
        }); // findOne after
      // createWithinApproval reuses the grant write path; run its `extra` callback so the request flip
      // is exercised against the tx client.
      grants.createWithinApproval.mockImplementation(
        async (
          data: unknown,
          _principal: unknown,
          extra: (tx: unknown, g: { id: string }) => Promise<void>,
        ) => {
          void data;
          accessRequest.updateMany.mockResolvedValue({ count: 1 });
          await extra({ accessRequest }, { id: 'grant_new' });
          return { id: 'grant_new' };
        },
      );

      const result = await service.approve(REQ_ID, HUMAN_PRINCIPAL);

      expect(grants.createWithinApproval).toHaveBeenCalledTimes(1);
      const grantData = (
        grants.createWithinApproval.mock.calls as GrantCall[]
      )[0][0];
      expect(grantData).toMatchObject({
        userId: REQUESTER,
        applicationId: APP_ID,
        accessLevel: 'admin',
      });
      const flipArg = (
        accessRequest.updateMany.mock.calls as WriteCall[]
      )[0][0];
      expect(flipArg.where).toMatchObject({ id: REQ_ID, status: 'PENDING' });
      expect(flipArg.data).toMatchObject({
        status: 'APPROVED',
        decidedById: DECIDER,
        grantId: 'grant_new',
      });
      expect(result).toMatchObject({
        status: 'APPROVED',
        grantId: 'grant_new',
      });
    });

    it('409s when the request is already decided', async () => {
      accessRequest.findUnique.mockResolvedValue({
        id: REQ_ID,
        status: 'APPROVED',
      });

      await expect(
        service.approve(REQ_ID, HUMAN_PRINCIPAL),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(grants.createWithinApproval).not.toHaveBeenCalled();
    });

    it('404s when the request does not exist', async () => {
      accessRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approve(REQ_ID, HUMAN_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a service-account principal (deciding is human-only)', async () => {
      await expect(
        service.approve(REQ_ID, SA_PRINCIPAL),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.createWithinApproval).not.toHaveBeenCalled();
    });

    it('409s when the concurrent flip updates zero rows (raced decision)', async () => {
      accessRequest.findUnique.mockResolvedValue({
        id: REQ_ID,
        requesterId: REQUESTER,
        applicationId: APP_ID,
        accessLevel: null,
        status: 'PENDING',
      });
      grants.createWithinApproval.mockImplementation(
        async (
          _data: unknown,
          _principal: unknown,
          extra: (tx: unknown, g: { id: string }) => Promise<void>,
        ) => {
          accessRequest.updateMany.mockResolvedValue({ count: 0 });
          await extra({ accessRequest }, { id: 'grant_new' });
        },
      );

      await expect(
        service.approve(REQ_ID, HUMAN_PRINCIPAL),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('deny', () => {
    it('marks the request DENIED with the required reason + decider', async () => {
      accessRequest.findUnique
        .mockResolvedValueOnce({ id: REQ_ID, status: 'PENDING' }) // findPending
        .mockResolvedValueOnce({
          id: REQ_ID,
          status: 'DENIED',
          deniedReason: 'Not needed',
          decidedById: DECIDER,
        }); // findOne after
      accessRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.deny(
        REQ_ID,
        { reason: 'Not needed' },
        HUMAN_PRINCIPAL,
      );

      const arg = (accessRequest.updateMany.mock.calls as WriteCall[])[0][0];
      expect(arg.where).toMatchObject({ id: REQ_ID, status: 'PENDING' });
      expect(arg.data).toMatchObject({
        status: 'DENIED',
        deniedReason: 'Not needed',
        decidedById: DECIDER,
      });
      expect(result).toMatchObject({ status: 'DENIED' });
    });

    it('409s when the request is already decided', async () => {
      accessRequest.findUnique.mockResolvedValue({
        id: REQ_ID,
        status: 'DENIED',
      });

      await expect(
        service.deny(REQ_ID, { reason: 'x' }, HUMAN_PRINCIPAL),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(accessRequest.updateMany).not.toHaveBeenCalled();
    });

    it('403s a service-account principal (deciding is human-only)', async () => {
      await expect(
        service.deny(REQ_ID, { reason: 'x' }, SA_PRINCIPAL),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('findMine (self-scope carve-out)', () => {
    it('scopes the query strictly to the caller as requester', async () => {
      accessRequest.findMany.mockResolvedValue([]);
      accessRequest.count.mockResolvedValue(0);

      await service.findMine(REQUESTER, { limit: 50, offset: 0 } as never);

      const findManyArg = (
        accessRequest.findMany.mock.calls as FindManyCall[]
      )[0][0];
      expect(findManyArg.where).toEqual({ requesterId: REQUESTER });
    });
  });

  describe('findPage (estate-wide list filters)', () => {
    it('builds a where from status / applicationId / requesterId', async () => {
      accessRequest.findMany.mockResolvedValue([]);
      accessRequest.count.mockResolvedValue(0);

      await service.findPage(
        { status: 'PENDING', applicationId: APP_ID, requesterId: REQUESTER },
        { limit: 50, offset: 0 } as never,
      );

      const findManyArg = (
        accessRequest.findMany.mock.calls as FindManyCall[]
      )[0][0];
      expect(findManyArg.where).toEqual({
        status: 'PENDING',
        applicationId: APP_ID,
        requesterId: REQUESTER,
      });
    });
  });
});
