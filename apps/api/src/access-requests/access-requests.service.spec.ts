import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CreateAccessRequestSchema } from '@lazyit/shared';
import { AccessRequestsService } from './access-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { NotificationsService } from '../notifications/notifications.service';
import { adapterPgUniqueViolationMeta } from '../../test/prisma/unique-violation';
import {
  postgresLikeFindMany,
  walkAllPages,
} from '../../test/prisma/offset-window';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for the P2002 error class + erased types; the stand-in is defined INSIDE the factory
// (jest.mock is hoisted above module scope) and grabbed back below.
jest.mock('../../generated/prisma/client', () => {
  class KnownRequestError extends Error {
    code: string;
    meta?: Record<string, unknown>;
    constructor(code: string, meta?: Record<string, unknown>) {
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
        meta?: Record<string, unknown>,
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
type EmitCall = [
  {
    type: string;
    dedupeKey: string;
    recipientUserId?: string | null;
    severity?: string;
    summary?: string | null;
    title?: string;
    metadata?: Record<string, unknown>;
  },
];
type GrantCall = [Record<string, unknown>];
type FindManyCall = [{ where: unknown }];

describe('AccessRequestsService', () => {
  let service: AccessRequestsService;
  let accessRequest: AccessRequestMock;
  let application: { findFirst: jest.Mock; findUnique: jest.Mock };
  let user: { findUnique: jest.Mock; findFirst: jest.Mock };
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
    user = { findUnique: jest.fn(), findFirst: jest.fn() };
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
        new FakeKnownRequestError(
          'P2002',
          adapterPgUniqueViolationMeta(
            { index: 'access_requests_requester_application_pending_key' },
            'AccessRequest',
          ),
        ),
      );

      await expect(
        service.create(REQUESTER, { applicationId: APP_ID }),
      ).rejects.toThrow(
        new ConflictException(
          'You already have a pending access request for this application.',
        ),
      );
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

  describe('create on behalf of another person (#1645)', () => {
    const FILER = DECIDER;

    function primeCreate(target: Record<string, unknown> | null) {
      application.findFirst.mockResolvedValue({ id: APP_ID });
      user.findFirst.mockResolvedValue(target);
      accessRequest.findFirst.mockResolvedValue(null);
      accessRequest.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: REQ_ID, accessLevel: null, ...data }),
      );
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === FILER
              ? { firstName: 'Hal', lastName: 'Desk' }
              : { firstName: 'Ada', lastName: 'Lovelace' },
          ),
      );
    }

    it('files the request for the target and records the caller as filedById', async () => {
      primeCreate({ isActive: true, directoryOnly: false });

      const result = await service.create(FILER, {
        applicationId: APP_ID,
        requesterId: REQUESTER,
      });

      const data = (accessRequest.create.mock.calls as WriteCall[])[0][0].data;
      expect(data.requesterId).toBe(REQUESTER);
      expect(data.filedById).toBe(FILER);
      expect(result).toMatchObject({
        requesterId: REQUESTER,
        filedById: FILER,
      });
      const emitted = (notifications.emit.mock.calls as EmitCall[])[0][0];
      expect(emitted.title).toBe(
        'Hal Desk requested access to Jira on behalf of Ada Lovelace',
      );
      expect(emitted.metadata).toMatchObject({ filedById: FILER });
    });

    it('treats the caller naming themselves as a self-service request', async () => {
      primeCreate(null);

      await service.create(REQUESTER, {
        applicationId: APP_ID,
        requesterId: REQUESTER,
      });

      const data = (accessRequest.create.mock.calls as WriteCall[])[0][0].data;
      expect(data.requesterId).toBe(REQUESTER);
      expect(data.filedById).toBeNull();
      expect(user.findFirst).not.toHaveBeenCalled();
      const emitted = (notifications.emit.mock.calls as EmitCall[])[0][0];
      expect(emitted.title).toBe('Ada Lovelace requested access to Jira');
      expect(emitted.metadata).not.toHaveProperty('filedById');
    });

    it('treats an uppercase copy of the caller id as self-filed', async () => {
      primeCreate(null);
      const self = '11111111-1111-4111-8111-11111111abcd';
      const requesterId = CreateAccessRequestSchema.shape.requesterId.parse(
        self.toUpperCase(),
      );

      await service.create(self, { applicationId: APP_ID, requesterId });

      const data = (accessRequest.create.mock.calls as WriteCall[])[0][0].data;
      expect(data.requesterId).toBe(self);
      expect(data.filedById).toBeNull();
      expect(user.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      ['offboarded or missing', null],
      ['inactive', { isActive: false, directoryOnly: false }],
      ['directory-only (no account)', { isActive: true, directoryOnly: true }],
    ])('refuses a %s target with 400 and writes nothing', async (_, target) => {
      primeCreate(target);

      const err: unknown = await service
        .create(FILER, { applicationId: APP_ID, requesterId: REQUESTER })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'ACCESS_REQUEST_TARGET_UNAVAILABLE',
      });
      expect(accessRequest.create).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('applies the one-pending rule to the target, not the filer', async () => {
      primeCreate({ isActive: true, directoryOnly: false });
      accessRequest.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create(FILER, {
          applicationId: APP_ID,
          requesterId: REQUESTER,
        }),
      ).rejects.toThrow(
        new ConflictException(
          'This person already has a pending access request for this application.',
        ),
      );
      const lookup = (
        accessRequest.findFirst.mock.calls as Array<
          [{ where: Record<string, unknown> }]
        >
      )[0][0];
      expect(lookup.where).toEqual({
        requesterId: REQUESTER,
        applicationId: APP_ID,
        status: 'PENDING',
      });
      expect(accessRequest.create).not.toHaveBeenCalled();
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

    it('emits a targeted access_request.decided nudge to the requester on approval', async () => {
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
          requesterId: REQUESTER,
          applicationId: APP_ID,
          accessLevel: 'admin',
          status: 'APPROVED',
          deniedReason: null,
          grantId: 'grant_new',
          decidedById: DECIDER,
        }); // findOne after
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      grants.createWithinApproval.mockImplementation(
        async (
          _data: unknown,
          _principal: unknown,
          extra: (tx: unknown, g: { id: string }) => Promise<void>,
        ) => {
          accessRequest.updateMany.mockResolvedValue({ count: 1 });
          await extra({ accessRequest }, { id: 'grant_new' });
          return { id: 'grant_new' };
        },
      );

      await service.approve(REQ_ID, HUMAN_PRINCIPAL);

      // Exactly one nudge — the targeted decision, addressed to the requester (not over-emitted).
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const emitArg = (notifications.emit.mock.calls as EmitCall[])[0][0];
      expect(emitArg.type).toBe('access_request.decided');
      expect(emitArg.dedupeKey).toBe(`access_request.decided:${REQ_ID}`);
      expect(emitArg.recipientUserId).toBe(REQUESTER);
      expect(emitArg.severity).toBe('info');
    });

    it('does not let a failed decision nudge break the committed approval', async () => {
      accessRequest.findUnique
        .mockResolvedValueOnce({
          id: REQ_ID,
          requesterId: REQUESTER,
          applicationId: APP_ID,
          accessLevel: null,
          status: 'PENDING',
        })
        .mockResolvedValueOnce({
          id: REQ_ID,
          requesterId: REQUESTER,
          applicationId: APP_ID,
          accessLevel: null,
          status: 'APPROVED',
          deniedReason: null,
          grantId: 'grant_new',
          decidedById: DECIDER,
        });
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      grants.createWithinApproval.mockImplementation(
        async (
          _data: unknown,
          _principal: unknown,
          extra: (tx: unknown, g: { id: string }) => Promise<void>,
        ) => {
          accessRequest.updateMany.mockResolvedValue({ count: 1 });
          await extra({ accessRequest }, { id: 'grant_new' });
          return { id: 'grant_new' };
        },
      );
      notifications.emit.mockRejectedValue(new Error('bell down'));

      await expect(
        service.approve(REQ_ID, HUMAN_PRINCIPAL),
      ).resolves.toMatchObject({ status: 'APPROVED' });
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
      // A request already decided never emits a decision nudge.
      expect(notifications.emit).not.toHaveBeenCalled();
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

    it('emits a targeted access_request.decided nudge to the requester on denial', async () => {
      accessRequest.findUnique
        .mockResolvedValueOnce({ id: REQ_ID, status: 'PENDING' }) // findPending
        .mockResolvedValueOnce({
          id: REQ_ID,
          requesterId: REQUESTER,
          applicationId: APP_ID,
          accessLevel: null,
          status: 'DENIED',
          deniedReason: 'Not needed',
          decidedById: DECIDER,
        }); // findOne after
      application.findUnique.mockResolvedValue({ name: 'Jira' });
      accessRequest.updateMany.mockResolvedValue({ count: 1 });

      await service.deny(REQ_ID, { reason: 'Not needed' }, HUMAN_PRINCIPAL);

      // Exactly one nudge — the targeted decision, addressed to the requester (not over-emitted).
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const emitArg = (notifications.emit.mock.calls as EmitCall[])[0][0];
      expect(emitArg.type).toBe('access_request.decided');
      expect(emitArg.dedupeKey).toBe(`access_request.decided:${REQ_ID}`);
      expect(emitArg.recipientUserId).toBe(REQUESTER);
      expect(emitArg.severity).toBe('warning');
      // The requester is entitled to the denial reason — it rides the human summary.
      expect(emitArg.summary).toContain('Not needed');
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
      // A request already decided never emits a decision nudge.
      expect(notifications.emit).not.toHaveBeenCalled();
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

    it('serves every request exactly once across pages when they share a createdAt (#1644)', async () => {
      const createdAt = new Date('2026-10-01T00:00:00Z');
      const rows = Array.from({ length: 23 }, (_, i) => ({
        id: `req_${String(i).padStart(3, '0')}`,
        createdAt,
      }));
      accessRequest.findMany.mockImplementation(postgresLikeFindMany(rows));
      accessRequest.count.mockResolvedValue(rows.length);

      const served = await walkAllPages(
        (offset) =>
          service.findPage({}, { limit: 5, offset, deleted: 'active' }),
        5,
      );

      expect(served).toHaveLength(rows.length);
      expect(new Set(served)).toEqual(new Set(rows.map((r) => r.id)));
    });
  });
});
