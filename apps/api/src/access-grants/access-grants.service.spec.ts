import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AccessGrantsService } from './access-grants.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  postgresLikeFindMany,
  walkAllPages,
} from '../../test/prisma/offset-window';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for types (erased at runtime), so an empty object is enough.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type GrantMock = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findUniqueOrThrow: jest.Mock;
  count: jest.Mock;
};

// Shapes the create/update calls are cast to, so assertions stay type-safe (no-unsafe-* lint).
type GrantData = {
  userId?: string;
  applicationId?: string;
  accessLevel?: string;
  expiresAt?: Date | null;
  grantedAt?: Date;
  notes?: string | null;
  grantedById?: string;
  grantedBySaId?: string;
  revokedAt?: Date;
  revokedById?: string;
  revokedBySaId?: string;
};
type CreateCall = [{ data: GrantData }];
type UpdateCall = [{ where: { id: string }; data: GrantData }];
type UpdateManyCall = [
  { where: { id: string; revokedAt: null }; data: GrantData },
];
type FindManyCall = [{ where: Record<string, unknown>; orderBy: unknown }];

const VALID_ACTOR = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const APP_ID = 'app_cuid_1';
const SA_ID = 'sa_abcdefghijklmnopqrstuvwx';
// The unified principals (ADR-0048) — only the actor id matters to attribution; cast through `never`.
const HUMAN_PRINCIPAL = { kind: 'human', user: { id: VALID_ACTOR } } as never;
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(),
} as never;

describe('AccessGrantsService', () => {
  let service: AccessGrantsService;
  let accessGrant: GrantMock;
  let user: { findFirst: jest.Mock; findUnique: jest.Mock };
  let application: { findFirst: jest.Mock; findUnique: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  // ActorService is a pure resolver (the guard already validated the principal); the real instance is
  // used so it produces the genuine ActorAttribution from the principal each test passes (ADR-0048).
  let actor: ActorService;

  beforeEach(async () => {
    accessGrant = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn(),
    };
    user = { findFirst: jest.fn(), findUnique: jest.fn() };
    application = { findFirst: jest.fn(), findUnique: jest.fn() };
    // findPage uses the array form of $transaction (a tuple of two queries); batchRevoke uses the
    // callback form with the tx client. The mock supports BOTH: array → await each query; callback →
    // invoke with a tx whose accessGrant is the same mock (so per-item updates are asserted on it).
    prisma = {
      $transaction: jest.fn(
        (arg: Array<Promise<unknown>> | ((tx: unknown) => unknown)) =>
          Array.isArray(arg) ? Promise.all(arg) : arg({ accessGrant }),
      ),
    };
    actor = new ActorService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessGrantsService,
        {
          provide: PrismaService,
          useValue: { accessGrant, user, application, ...prisma },
        },
        { provide: ActorService, useValue: actor },
        {
          // No workflow fires in these tests (planForTrigger → null), so the outbox path is inert and
          // the grant assertions are unchanged. The dedicated outbox behaviour is in
          // access-grants.outbox.spec.ts.
          provide: WorkflowTriggerService,
          useValue: {
            planForTrigger: jest.fn().mockResolvedValue(null),
            buildRunData: jest.fn(),
            enqueue: jest.fn().mockResolvedValue(true),
          },
        },
        {
          // The notification emitter is best-effort and post-commit; these grant tests don't assert on
          // it (the emitter behaviour is covered in notifications.emitters.spec.ts), so a no-op mock
          // keeps the grant assertions unchanged.
          provide: NotificationsService,
          useValue: { emit: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = moduleRef.get(AccessGrantsService);
  });

  /** user.findFirst echoes the queried id back as a live user (grantee/application lookups pass). */
  const allUsersLive = () =>
    user.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve({
        id: args.where.id,
        isActive: true,
        directoryOnly: false,
      }),
    );

  // --- create -------------------------------------------------------------
  it('opens a grant for a live user + application; no actor header => grantedById unset', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create({ userId: USER_ID, applicationId: APP_ID });

    const calls = accessGrant.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.userId).toBe(USER_ID);
    expect(calls[0][0].data.applicationId).toBe(APP_ID);
    expect(calls[0][0].data.grantedById).toBeUndefined();
  });

  it('records grantedById from a HUMAN principal (grantedBySaId stays null)', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create(
      { userId: USER_ID, applicationId: APP_ID },
      HUMAN_PRINCIPAL,
    );

    const calls = accessGrant.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.grantedById).toBe(VALID_ACTOR);
    expect(calls[0][0].data.grantedBySaId).toBeUndefined();
  });

  it('records grantedBySaId from a SERVICE-ACCOUNT principal (grantedById stays null) — ADR-0048', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create(
      { userId: USER_ID, applicationId: APP_ID },
      SA_PRINCIPAL,
    );

    const calls = accessGrant.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.grantedBySaId).toBe(SA_ID);
    expect(calls[0][0].data.grantedById).toBeUndefined();
  });

  it('persists accessLevel and converts expiresAt / grantedAt to Date', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'admin',
      expiresAt: '2026-12-31T00:00:00.000Z',
      grantedAt: '2026-01-01T00:00:00.000Z',
      notes: 'temp consultant',
    });

    const data = (accessGrant.create.mock.calls as CreateCall[])[0][0].data;
    expect(data.accessLevel).toBe('admin');
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(data.grantedAt).toBeInstanceOf(Date);
    expect(data.notes).toBe('temp consultant');
  });

  it('allows multi-grant: a 2nd grant for the same (user, app) at a different level is not blocked', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g' });

    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'admin',
    });
    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'viewer',
    });

    // No uniqueness pre-check: both creates go through (contrast AssetAssignment).
    expect(accessGrant.create).toHaveBeenCalledTimes(2);
  });

  it('rejects (400) when the grantee user is not live', async () => {
    user.findFirst.mockResolvedValue(null);
    application.findFirst.mockResolvedValue({ id: APP_ID });

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  it('rejects (400) when the application is not live', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  it('rejects (400) when the grantee is a DIRECTORY person (INV-2, ADR-0069 REDESIGN §7)', async () => {
    // A directory-only person has no account → it must NEVER be the subject of an AccessGrant (orphan,
    // irrevocable access). The block lifts the moment they sign in (directoryOnly flips to false).
    user.findFirst.mockResolvedValue({
      id: USER_ID,
      directoryOnly: true,
      isActive: true,
    });
    application.findFirst.mockResolvedValue({ id: APP_ID });

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  // Issue #1661: a deactivated (live but inactive) person cannot sign in, so no grant may open for them.
  it('rejects (400 ACCESS_GRANT_PERSON_INACTIVE) when the grantee is deactivated', async () => {
    user.findFirst.mockResolvedValue({
      id: USER_ID,
      directoryOnly: false,
      isActive: false,
    });
    application.findFirst.mockResolvedValue({ id: APP_ID });

    const error = await service
      .create({ userId: USER_ID, applicationId: APP_ID })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({ code: 'ACCESS_GRANT_PERSON_INACTIVE' }),
    );
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  it('the approval path refuses a deactivated grantee too, before any write', async () => {
    user.findFirst.mockResolvedValue({
      id: USER_ID,
      directoryOnly: false,
      isActive: false,
    });
    application.findFirst.mockResolvedValue({ id: APP_ID });
    const extra = jest.fn();

    await expect(
      service.createWithinApproval(
        { userId: USER_ID, applicationId: APP_ID },
        HUMAN_PRINCIPAL,
        extra,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // --- findAll ------------------------------------------------------------
  it('findAll defaults to active-only + include-expired, newest first', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({});

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { revokedAt: null },
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll with activeOnly=false drops the revokedAt filter', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ activeOnly: false });

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll filters by userId and applicationId', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ userId: USER_ID, applicationId: APP_ID });

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, applicationId: APP_ID, revokedAt: null },
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll with includeExpired=false adds an (expiresAt null OR in the future) filter', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ includeExpired: false });

    const where = (accessGrant.findMany.mock.calls as FindManyCall[])[0][0]
      .where as {
      revokedAt: null;
      OR: Array<{ expiresAt: null | { gt: Date } }>;
    };
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ expiresAt: null });
    const future = where.OR[1].expiresAt as { gt: Date };
    expect(future.gt).toBeInstanceOf(Date);
  });

  // --- findPage (paginated) -----------------------------------------------
  it('findPage runs findMany(take/skip) + count over the SAME where inside one $transaction', async () => {
    accessGrant.findMany.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]);
    accessGrant.count.mockResolvedValue(42);

    const result = await service.findPage(
      { userId: USER_ID },
      { limit: 2, offset: 4, deleted: 'active' },
    );

    // One transaction wrapping both queries (count can't drift from the page).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const findManyArgs = (
      accessGrant.findMany.mock.calls as FindManyCall[]
    )[0][0];
    const countArgs = (
      accessGrant.count.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    // take/skip come from the page window.
    expect(findManyArgs).toEqual({
      where: { userId: USER_ID, revokedAt: null },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
      take: 2,
      skip: 4,
    });
    // count uses the identical where (no take/skip/orderBy).
    expect(countArgs.where).toEqual({ userId: USER_ID, revokedAt: null });
    // The envelope: items + total + the echoed window.
    expect(result).toEqual({
      items: [{ id: 'g1' }, { id: 'g2' }],
      total: 42,
      limit: 2,
      offset: 4,
    });
  });

  it('findPage defaults to active-only and newest-first like findAll', async () => {
    accessGrant.findMany.mockResolvedValue([]);
    accessGrant.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

    const findManyArgs = (
      accessGrant.findMany.mock.calls as FindManyCall[]
    )[0][0];
    expect(findManyArgs).toMatchObject({
      where: { revokedAt: null },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      skip: 0,
    });
  });

  it('findPage serves every grant exactly once across pages when they share a grantedAt (#1644)', async () => {
    const grantedAt = new Date('2026-10-01T00:00:00Z');
    const rows = Array.from({ length: 23 }, (_, i) => ({
      id: `grant_${String(i).padStart(3, '0')}`,
      grantedAt,
    }));
    accessGrant.findMany.mockImplementation(postgresLikeFindMany(rows));
    accessGrant.count.mockResolvedValue(rows.length);

    const served = await walkAllPages(
      (offset) => service.findPage({}, { limit: 5, offset, deleted: 'active' }),
      5,
    );

    expect(served).toHaveLength(rows.length);
    expect(new Set(served)).toEqual(new Set(rows.map((r) => r.id)));
  });

  // --- findOne ------------------------------------------------------------
  it('returns a grant by id when it exists', async () => {
    const found = { id: 'g1', revokedAt: null };
    accessGrant.findUnique.mockResolvedValue(found);

    await expect(service.findOne('g1')).resolves.toEqual(found);
    expect(accessGrant.findUnique).toHaveBeenCalledWith({
      where: { id: 'g1' },
    });
  });

  it('throws NotFound when the grant does not exist', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- revoke -------------------------------------------------------------
  it('revokes an active grant: sets revokedAt + revokedById (HUMAN) + notes', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    const revokedRow = { id: 'g1', revokedAt: new Date() };
    accessGrant.findUniqueOrThrow.mockResolvedValue(revokedRow);

    const result = await service.revoke(
      'g1',
      { notes: 'left the company' },
      HUMAN_PRINCIPAL,
    );

    const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
    // Conditional on still being active, so a racing revoke can't be overwritten (AUD-043).
    expect(calls[0][0].where).toEqual({ id: 'g1', revokedAt: null });
    expect(result).toBe(revokedRow);
    expect(calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.revokedById).toBe(VALID_ACTOR);
    expect(calls[0][0].data.revokedBySaId).toBeUndefined();
    expect(calls[0][0].data.notes).toBe('left the company');
  });

  it('revokes for a SERVICE-ACCOUNT principal: sets revokedBySaId (revokedById stays null) — ADR-0048', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });

    await service.revoke('g1', {}, SA_PRINCIPAL);

    const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
    expect(calls[0][0].data.revokedBySaId).toBe(SA_ID);
    expect(calls[0][0].data.revokedById).toBeUndefined();
  });

  it('revokes without a principal (both revoke actor columns stay unset)', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });

    await service.revoke('g1', {});

    const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
    expect(calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.revokedById).toBeUndefined();
    expect(calls[0][0].data.revokedBySaId).toBeUndefined();
  });

  it('rejects revoking an already-revoked grant with 409', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: new Date(),
    });

    await expect(service.revoke('g1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(accessGrant.updateMany).not.toHaveBeenCalled();
  });

  it('AUD-043: a revoke that loses the race to a concurrent revoke gets 409, not an overwrite', async () => {
    // The pre-check saw the grant active, but another revoke (e.g. the expiry sweeper) committed first.
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.revoke('g1', {}, HUMAN_PRINCIPAL),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(accessGrant.update).not.toHaveBeenCalled();
    expect(accessGrant.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('does not revoke a missing grant', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(service.revoke('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(accessGrant.updateMany).not.toHaveBeenCalled();
  });

  // --- updateNotes --------------------------------------------------------
  it('updates only the notes after confirming the grant exists', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1', notes: 'note' });

    await service.updateNotes('g1', { notes: 'note' });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { notes: 'note' },
    });
  });

  it('clears the notes when passed null', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1', notes: null });

    await service.updateNotes('g1', { notes: null });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { notes: null },
    });
  });

  // --- updateExpiry -------------------------------------------------------
  const GRANTED_AT = new Date('2026-01-01T12:00:00.000Z');

  it('updates the expiry, converting the ISO string to a Date', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: null,
      grantedAt: GRANTED_AT,
    });
    accessGrant.update.mockResolvedValue({ id: 'g1' });

    await service.updateExpiry('g1', { expiresAt: '2027-01-01T00:00:00.000Z' });

    const calls = accessGrant.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data.expiresAt).toBeInstanceOf(Date);
  });

  it('clears the expiry (permanent grant) when passed null', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: null,
      grantedAt: GRANTED_AT,
    });
    accessGrant.update.mockResolvedValue({ id: 'g1', expiresAt: null });

    await service.updateExpiry('g1', { expiresAt: null });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { expiresAt: null },
    });
  });

  it('AUD-097: rejects an expiry earlier than the stored grantedAt with 400', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: null,
      grantedAt: GRANTED_AT,
    });

    await expect(
      service.updateExpiry('g1', { expiresAt: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.update).not.toHaveBeenCalled();
  });

  it('accepts an expiry exactly at grantedAt (on or after, like create)', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: null,
      grantedAt: GRANTED_AT,
    });
    accessGrant.update.mockResolvedValue({ id: 'g1' });

    await service.updateExpiry('g1', { expiresAt: GRANTED_AT.toISOString() });

    const calls = accessGrant.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data.expiresAt).toEqual(GRANTED_AT);
  });

  it('does not update the expiry of a missing grant', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(
      service.updateExpiry('missing', { expiresAt: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(accessGrant.update).not.toHaveBeenCalled();
  });

  // --- batchRevoke (bulk, ADR-0030 amendment) -----------------------------
  describe('batchRevoke', () => {
    it('revokes each active grant individually (per-grant revokedAt) in one transaction', async () => {
      // g1, g2 active; g3 already revoked; g4 not found.
      accessGrant.findMany.mockResolvedValue([
        { id: 'g1', revokedAt: null },
        { id: 'g2', revokedAt: null },
        { id: 'g3', revokedAt: new Date() },
      ]);

      const result = await service.batchRevoke(
        ['g1', 'g2', 'g3', 'g4'],
        'offboarding',
      );

      // One transaction wraps the whole batch.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Per-grant: one update per succeeded id (NOT one for the whole batch).
      expect(accessGrant.updateMany).toHaveBeenCalledTimes(2);
      const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
      expect(calls[0][0].where).toEqual({ id: 'g1', revokedAt: null });
      expect(calls[0][0].data.revokedAt).toBeInstanceOf(Date);
      expect(calls[0][0].data.notes).toBe('offboarding');
      expect(calls[1][0].where).toEqual({ id: 'g2', revokedAt: null });
      // Per-id outcome: g1/g2 succeeded; g3 already revoked; g4 not found.
      expect(result).toEqual({
        requested: 4,
        succeeded: ['g1', 'g2'],
        skipped: [
          { id: 'g3', reason: 'already_in_state' },
          { id: 'g4', reason: 'not_found' },
        ],
      });
    });

    it('stamps a HUMAN principal as revokedById on each grant', async () => {
      accessGrant.findMany.mockResolvedValue([{ id: 'g1', revokedAt: null }]);

      await service.batchRevoke(['g1'], null, HUMAN_PRINCIPAL);

      const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
      expect(calls[0][0].data.revokedById).toBe(VALID_ACTOR);
      expect(calls[0][0].data.revokedBySaId).toBeUndefined();
    });

    it('notes: null CLEARS the note; omitted (undefined) PRESERVES it — matching revoke()/updateNotes()', async () => {
      accessGrant.findMany.mockResolvedValue([{ id: 'g1', revokedAt: null }]);

      // Explicit null → write `notes: null` (clear the existing note).
      await service.batchRevoke(['g1'], null, HUMAN_PRINCIPAL);
      let calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
      expect('notes' in calls[0][0].data).toBe(true);
      expect(calls[0][0].data.notes).toBeNull();

      accessGrant.updateMany.mockClear();

      // Omitted (undefined) → no `notes` key written (preserve whatever the grant already has).
      await service.batchRevoke(['g1'], undefined, HUMAN_PRINCIPAL);
      calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
      expect('notes' in calls[0][0].data).toBe(false);
    });

    it('stamps a SERVICE-ACCOUNT principal as revokedBySaId on each grant — ADR-0048', async () => {
      accessGrant.findMany.mockResolvedValue([{ id: 'g1', revokedAt: null }]);

      await service.batchRevoke(['g1'], null, SA_PRINCIPAL);

      const calls = accessGrant.updateMany.mock.calls as UpdateManyCall[];
      expect(calls[0][0].data.revokedBySaId).toBe(SA_ID);
      expect(calls[0][0].data.revokedById).toBeUndefined();
    });

    it('AUD-043: a grant revoked concurrently after the snapshot is skipped, the rest still commit', async () => {
      accessGrant.findMany.mockResolvedValue([
        { id: 'g1', revokedAt: null },
        { id: 'g2', revokedAt: null },
      ]);
      // g1's conditional write matches nothing: another revoke committed after the snapshot read.
      accessGrant.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      const result = await service.batchRevoke(
        ['g1', 'g2'],
        undefined,
        HUMAN_PRINCIPAL,
      );

      expect(result).toEqual({
        requested: 2,
        succeeded: ['g2'],
        skipped: [{ id: 'g1', reason: 'already_in_state' }],
      });
    });

    it('opens no transaction when nothing is revocable', async () => {
      accessGrant.findMany.mockResolvedValue([
        { id: 'g1', revokedAt: new Date() },
      ]);

      const result = await service.batchRevoke(['g1'], undefined);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result.succeeded).toEqual([]);
      expect(result.skipped).toEqual([
        { id: 'g1', reason: 'already_in_state' },
      ]);
    });
  });

  // NOTE: two rules are enforced at the DB layer and verified against Postgres rather than here
  // (mocked unit tests have no DB — ADR-0012): (1) FK `onDelete: Restrict` blocks hard-deleting a
  // user/application that has grants (P2003 -> 400); (2) there is intentionally NO uniqueness
  // constraint, so multi-grant is a DB-level non-rule. The create() live-checks above cover the
  // soft-deleted-reference case (400) that the FK cannot.
});
