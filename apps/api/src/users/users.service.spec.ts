import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { PasswordResetUnsupportedError, UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { UserHistoryService } from '../user-history/user-history.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
import {
  AdminResetLinkError,
  PasswordLifecycleService,
} from '../auth/local/password-lifecycle.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  // UsersService imports Role as a VALUE (Role.VIEWER) for the ADR-0043 create default, so the mock
  // must expose it or create() dereferences undefined.
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaUserMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  count: jest.Mock;
  // roleCounts() (issue #693) aggregates the live directory by `role` with one groupBy.
  groupBy: jest.Mock;
};

// The transaction client the offboarding writes go through; $transaction runs the callback with it.
// `userHistory.create` is present so the structural UserHistoryWriter type is satisfied when the real
// service threads the tx client; the emission itself is asserted via the mocked UserHistoryService.
type TxMock = {
  user: { update: jest.Mock };
  accessGrant: { updateMany: jest.Mock; create: jest.Mock };
  assetAssignment: { create: jest.Mock };
  workflowRun: { create: jest.Mock };
  userHistory: { create: jest.Mock };
  // Issue #869: the offboarding also revokes the user's Secret-vault memberships. `findMany` reads the
  // affected vaults' metadata (for the rotation prompt) BEFORE `deleteMany` hard-drops the rows, then
  // `secretAuditLog.createMany` appends one MEMBERSHIP_REVOKED row per revoked vault.
  vaultMembership: { findMany: jest.Mock; deleteMany: jest.Mock };
  secretAuditLog: { createMany: jest.Mock };
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let user: PrismaUserMock;
  let search: SearchMock;
  let tx: TxMock;
  let assignments: { releaseAllForUser: jest.Mock };
  const originalAuthMode = process.env.AUTH_MODE;
  // ADR-0086 §5 (F1c): the local provisioning primitive. Mocked so the local-mode create/reset tests
  // assert hash-store/temp-password behaviour without running argon2.
  let provisioning: {
    credentialFields: jest.Mock;
    generateTempPassword: jest.Mock;
  };
  // Issue #1268: the local password-lifecycle machinery the `email` delivery delegates the token + mail
  // to. Its own token/SMTP behaviour is covered in password-lifecycle.service.spec.ts; here it stands in
  // so the ORCHESTRATION (status mapping, audit, session revocation) is what gets asserted.
  let passwordLifecycle: {
    sendAdminResetLink: jest.Mock;
    isOutboundEmailReady: jest.Mock;
  };
  // DEBT-2 (issue #185): the append-only UserHistory emitter. Mocked so each write-path assertion can
  // check WHICH event was recorded (and with which payload/actor) without a DB.
  let history: { record: jest.Mock; list: jest.Mock };
  // ADR-0058 clone: the asset-history emitter (ASSIGNED per cloned assignment) and the workflow-engine
  // trigger (the engine toggle fires/suppresses ACCESS_GRANTED).
  let assetHistory: { record: jest.Mock };
  let workflowTrigger: {
    planForTrigger: jest.Mock;
    buildRunData: jest.Mock;
    enqueue: jest.Mock;
  };
  // ADR-0058 §4 / ADR-0056 §3 (issue #359): the bell emitter the clone reuses post-commit for every
  // cloned grant. Mocked so the clone tests assert WHICH grants nudged the bell, without a DB.
  let accessGrants: { emitGrantNotifications: jest.Mock };
  // The base prisma mock (lifted so the clone tests can prime assetAssignment/accessGrant/asset reads,
  // and the #386 list-count tests can prime / inspect the per-page `groupBy` aggregations).
  let prismaMock: {
    assetAssignment: { findMany: jest.Mock; groupBy: jest.Mock };
    accessGrant: { findMany: jest.Mock; groupBy: jest.Mock };
    asset: { findMany: jest.Mock };
    application: { findMany: jest.Mock };
  };
  /** Accessor for the lifted prisma mock — keeps the clone tests readable. */
  const prismaRef = () => prismaMock;

  beforeEach(async () => {
    user = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      // Default: there is at least one OTHER admin, so the last-admin guard is a no-op unless a test
      // overrides this to 0 to simulate the final administrator.
      count: jest.fn().mockResolvedValue(1),
      // Backs roleCounts() (issue #693). Default empty → every role defaults to 0; the role-counts
      // tests override this with per-role groups.
      groupBy: jest.fn().mockResolvedValue([]),
    };
    tx = {
      // A real jest.Mock so offboard assertions (`tx.user.update.mockResolvedValue`, `.toHaveBeenCalled`)
      // keep working — but it DELEGATES to the base `user.update` by default, so the linked-create,
      // update and restore paths (which now run user.update through the tx client) return whatever a
      // test configured on `user.update`. Offboard tests override this with their own mockResolvedValue.
      user: {
        update: jest.fn((args: unknown) => user.update(args) as unknown),
      },
      accessGrant: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // Echo the persisted shape the clone reads back (id + applicationId + accessLevel) so the
        // post-commit bell emitter (issue #359) receives a realistic grant. accessLevel defaults to
        // null when the create omits it (mirrors the column default).
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'cloned-grant-1',
            applicationId: args.data.applicationId,
            accessLevel: args.data.accessLevel ?? null,
          }),
        ),
      },
      assetAssignment: {
        create: jest.fn().mockResolvedValue({ id: 'cloned-assign-1' }),
      },
      workflowRun: {
        create: jest.fn().mockResolvedValue({ id: 'cloned-run-1' }),
      },
      userHistory: { create: jest.fn() },
      // Issue #869 offboard vault-membership revoke. Defaults: the user is a member of no vault, so the
      // read is empty and the audit createMany is skipped. Offboard tests override findMany per scenario.
      vaultMembership: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      secretAuditLog: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      user,
      // Base-client userHistory.create — present for the non-transactional emission paths (OIDC create,
      // password reset). The emission is asserted via the mocked UserHistoryService below.
      userHistory: { create: jest.fn() },
      // ADR-0058 clone plan helpers read the SOURCE's active assignments/grants and live assets here.
      // Defaults are empty; the clone tests override them per scenario. `groupBy` backs the #386 list
      // activity counts (assets-in-possession / app-accesses); default empty result → every row counts 0.
      assetAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      accessGrant: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      asset: { findMany: jest.fn().mockResolvedValue([]) },
      // ADR-0058 clone: planClonedGrants reads which selected grants reference a LIVE application (the
      // soft-delete extension auto-scopes to live rows). Default ECHOES the requested ids back as live —
      // so nothing is treated as soft-deleted unless a test overrides it (mirrors planClonedAssignments'
      // asset.findMany, but defaulting to "all live" since most grant tests don't exercise a deleted app).
      application: {
        findMany: jest.fn((args: { where?: { id?: { in?: string[] } } }) =>
          Promise.resolve(
            (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
          ),
        ),
      },
      // Handles BOTH forms: callback (offboard / linked-create / update / restore / clone) with the tx
      // client, and array (findPage's [findMany, count]) which resolves each promise in the array.
      $transaction: jest.fn(
        (arg: ((client: TxMock) => unknown) | Promise<unknown>[]) =>
          Array.isArray(arg) ? Promise.all(arg) : arg(tx),
      ),
    };
    prismaMock = prisma;
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // AssetAssignmentsService is mocked; its own logic is covered in its spec. Default: no active
    // assignments to release.
    assignments = { releaseAllForUser: jest.fn().mockResolvedValue([]) };
    // Default posture: OIDC. The local-mode blocks flip AUTH_MODE themselves.
    process.env.AUTH_MODE = 'oidc';
    // Local provisioning primitive (ADR-0086 §5). Defaults return a deterministic hash fragment + temp
    // password so the local-mode tests can assert the stored fields without argon2.
    provisioning = {
      credentialFields: jest.fn().mockResolvedValue({
        passwordHash: '$argon2id$hash',
        passwordUpdatedAt: new Date('2026-07-03T00:00:00.000Z'),
        mustChangePassword: true,
      }),
      generateTempPassword: jest.fn().mockReturnValue('Temp-Pass-9xZ!'),
    };
    passwordLifecycle = {
      sendAdminResetLink: jest.fn().mockResolvedValue({
        sentTo: 'user@example.com',
        expiresInMinutes: 60,
      }),
      isOutboundEmailReady: jest.fn().mockResolvedValue(true),
    };
    // A no-op PinoLogger stand-in (the service uses it for structured write-back audit lines).
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as PinoLogger;

    // UserHistoryService mock (DEBT-2). record() resolves; assertions inspect its call args per path.
    history = {
      record: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
    };
    // AssetHistory + WorkflowTrigger (ADR-0058 clone). Default no-op; the clone tests below override
    // them to assert the ASSIGNED row + the engine-toggle fire/suppress behaviour.
    assetHistory = { record: jest.fn().mockResolvedValue(undefined) };
    workflowTrigger = {
      planForTrigger: jest.fn().mockResolvedValue(null),
      buildRunData: jest
        .fn()
        .mockReturnValue({ idempotencyKey: 'ACCESS_GRANTED:g:0' }),
      enqueue: jest.fn().mockResolvedValue(true),
    };
    // AccessGrantsService bell emitter (ADR-0056 §3 / issue #359). Default resolves; the clone tests
    // assert it is called once per cloned grant, independent of the engine toggle.
    accessGrants = {
      emitGrantNotifications: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
        { provide: AssetAssignmentsService, useValue: assignments },
        { provide: AssetHistoryService, useValue: assetHistory },
        { provide: UserHistoryService, useValue: history },
        { provide: WorkflowTriggerService, useValue: workflowTrigger },
        { provide: AccessGrantsService, useValue: accessGrants },
        { provide: LocalProvisioningService, useValue: provisioning },
        { provide: PasswordLifecycleService, useValue: passwordLifecycle },
        { provide: getLoggerToken(UsersService.name), useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = originalAuthMode;
  });

  it('OIDC create: a plain row + CREATED history, no IdP call (ADR-0102)', async () => {
    const dto = { email: 'a@b.com', firstName: 'Ada', lastName: 'Lovelace' };
    const created = {
      id: 'uuid-1',
      ...dto,
      isActive: true,
      role: 'VIEWER',
      externalId: null,
      deletedAt: null,
    };
    user.create.mockResolvedValue(created);

    // The service returns the SERIALIZED wire shape (ADR-0058): the manager FK is resolved (null here)
    // and the raw manager columns are dropped.
    await expect(service.create(dto)).resolves.toEqual({
      ...created,
      manager: null,
      // Issue #1422: the wire always carries the UI preferences (null = never chosen).
      locale: null,
      theme: null,
    });
    // ADR-0043: an omitted role defaults to VIEWER (least-privilege), set explicitly by the service.
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'VIEWER' },
    });
    // externalId stays null: JIT links it on the person's first sign-in (ADR-0038).
    expect(user.update).not.toHaveBeenCalled();
    // Fire-and-forget search sync (ADR-0035).
    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'a@b.com',
    });
    expect(search.remove).not.toHaveBeenCalled();

    // DEBT-2 (issue #185): a CREATED UserHistory row, with no actor (anonymous create → {}).
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(prismaMock, {
      userId: 'uuid-1',
      eventType: 'CREATED',
      actor: {},
    });
  });

  it('defaults an omitted role to VIEWER (ADR-0043 — uniform least-privilege default)', async () => {
    const dto = { email: 'v@b.com', firstName: 'Viv', lastName: 'Ian' };
    user.create.mockResolvedValue({ id: 'uuid-v', ...dto, role: 'VIEWER' });

    await service.create(dto);

    const createCalls = user.create.mock.calls as Array<
      [{ data: { role: string } }]
    >;
    expect(createCalls[0][0].data.role).toBe('VIEWER');
  });

  it('honours an explicit role on create (ADMIN-gated controller may pass any role)', async () => {
    const dto = {
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'ADMIN' as const,
    };
    user.create.mockResolvedValue({ id: 'uuid-a', ...dto });

    await service.create(dto);

    // An explicitly-supplied role is preserved (not overridden by the VIEWER default).
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'ADMIN' },
    });
  });

  it('OIDC create never hard-deletes the new row, even when a later step fails', async () => {
    const dto = { email: 'c@b.com', firstName: 'Caro', lastName: 'Line' };
    user.create.mockResolvedValue({
      id: 'uuid-c',
      ...dto,
      role: 'VIEWER',
      externalId: null,
    });
    history.record.mockRejectedValue(new Error('history write failed'));

    await expect(service.create(dto)).rejects.toThrow('history write failed');
    // No compensation path: a created row is never hard-deleted (ADR-0102).
    expect(user.delete).not.toHaveBeenCalled();
  });

  // ADR-0064 (issue #411) — admin temporary-password provisioning lives only in local mode. Under OIDC
  // the operator's IdP owns the credential (ADR-0102 §5).
  it('OIDC: rejects a supplied password with 400 and creates NO row', async () => {
    const dto = {
      email: 'oidc@b.com',
      firstName: 'Oi',
      lastName: 'Dc',
      password: 'Str0ng!Pass',
    };

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Validated BEFORE the write: no row, no IdP call.
    expect(user.create).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
    expect(search.upsert).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
  });

  // ADR-0086 §5 (F1c) — local-mode create. A supplied password is HASHED to passwordHash (no IdP, no
  // 400); a no-password create lands password-less (imported / provision-later); directoryOnly unaffected.
  describe('local-mode create (ADR-0086 §5)', () => {
    beforeEach(() => {
      process.env.AUTH_MODE = 'local';
    });

    it('hashes a supplied password onto passwordHash (mustChangePassword=true), no IdP call, no 400', async () => {
      const dto = {
        email: 'l@b.com',
        firstName: 'Lo',
        lastName: 'Cal',
        password: 'Str0ng!Pass',
      };
      user.create.mockResolvedValue({
        id: 'uuid-l',
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: 'VIEWER',
        externalId: null,
        deletedAt: null,
      });

      await service.create(dto);

      // The password is hashed via the provisioning primitive as an admin-provisioned temp credential.
      expect(provisioning.credentialFields).toHaveBeenCalledWith(
        'Str0ng!Pass',
        {
          mustChangePassword: true,
        },
      );
      // The row is created WITH the credential fields and NO password plaintext / NO externalId.
      const createArg = (
        user.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
      )[0][0];
      expect(createArg.data).toMatchObject({
        email: 'l@b.com',
        role: 'VIEWER',
        passwordHash: '$argon2id$hash',
        mustChangePassword: true,
      });
      expect(createArg.data).not.toHaveProperty('password');
      // No IdP mirror at all in local mode.
      expect(user.update).not.toHaveBeenCalled();
      // The CREATED history row is still appended.
      expect(history.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: 'uuid-l', eventType: 'CREATED' }),
      );
    });

    it('a no-password local create lands password-less (imported / provision-later): no hashing, no credential fields', async () => {
      const dto = { email: 'imp@b.com', firstName: 'Im', lastName: 'Port' };
      user.create.mockResolvedValue({
        id: 'uuid-imp',
        ...dto,
        role: 'VIEWER',
        externalId: null,
        deletedAt: null,
      });

      await service.create(dto);

      expect(provisioning.credentialFields).not.toHaveBeenCalled();
      const createArg = (
        user.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
      )[0][0];
      expect(createArg.data).not.toHaveProperty('passwordHash');
    });
  });

  // ADR-0069 REDESIGN §4.5 (Etapa 2): the directory-only create branch (`skipIdpWriteBack`).
  describe('directory-only create (skipIdpWriteBack, ADR-0069 REDESIGN §4.5)', () => {
    it('creates a directory person WITHOUT calling the IdP', async () => {
      const dto = { email: 'dir@b.com', firstName: 'Dir', lastName: 'Person' };
      const created = {
        id: 'uuid-dir',
        ...dto,
        role: 'VIEWER',
        externalId: null,
        directoryOnly: true,
        directoryAttrs: { jobTitle: 'Tech' },
        deletedAt: null,
      };
      user.create.mockResolvedValue(created);

      const result = await service.create(dto, 'actor-1', {
        skipIdpWriteBack: true,
        createdPayload: { source: 'import', sessionId: 's1', rowIndex: 0 },
        directoryAttrs: { jobTitle: 'Tech' },
      });

      // The row is created with directoryOnly=true + the routed directoryAttrs, role forced VIEWER.
      expect(user.create).toHaveBeenCalledWith({
        data: {
          ...dto,
          role: 'VIEWER',
          directoryOnly: true,
          directoryAttrs: { jobTitle: 'Tech' },
        },
      });
      // The CREATED history row is emitted on the base client with the import provenance payload,
      // attributed to the actor.
      expect(history.record).toHaveBeenCalledWith(prismaMock, {
        userId: 'uuid-dir',
        eventType: 'CREATED',
        payload: { source: 'import', sessionId: 's1', rowIndex: 0 },
        actor: { userId: 'actor-1' },
      });
      expect(search.upsert).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ id: 'uuid-dir' }),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'uuid-dir' }));
    });

    it('forces VIEWER even if a role somehow reached the payload (role-escalation closed)', async () => {
      const dto = {
        email: 'dir2@b.com',
        firstName: 'D',
        lastName: 'P',
        role: 'ADMIN' as const,
      };
      user.create.mockResolvedValue({ id: 'uuid-d2', ...dto, role: 'VIEWER' });

      await service.create(dto, undefined, { skipIdpWriteBack: true });

      const createArg = (
        user.create.mock.calls as Array<
          [{ data: { role: string; directoryOnly: boolean } }]
        >
      )[0][0];
      expect(createArg.data.role).toBe('VIEWER');
      expect(createArg.data.directoryOnly).toBe(true);
    });
  });

  // ADR-0086 §5 amendment (issue #1072): the LOCAL-mode onboarding of a directory person — mint a
  // one-time temp password so an imported, login-less person can sign in. No self-service, no role
  // widening, temp password shown once.
  describe('provisionLocalAccount (local onboarding, ADR-0086 §5 / issue #1072)', () => {
    const DIRECTORY = {
      id: 'uuid-onb',
      email: 'imported@corp.com',
      firstName: 'Im',
      lastName: 'Ported',
      role: 'VIEWER',
      isActive: true,
      externalId: null,
      passwordHash: null,
      directoryOnly: true,
      deletedAt: null,
    };

    beforeEach(() => {
      process.env.AUTH_MODE = 'local';
    });

    it('mints + hashes a temp password, flips directoryOnly=false, keeps the role, audits UPDATED, returns the temp password once', async () => {
      user.findFirst.mockResolvedValue(DIRECTORY);
      user.update.mockResolvedValue({
        ...DIRECTORY,
        directoryOnly: false,
        passwordHash: '$argon2id$hash',
        mustChangePassword: true,
      });

      const result = await service.provisionLocalAccount('uuid-onb', 'admin-1');

      // The temp password is generated + hashed via the provisioning primitive (forced-change credential).
      expect(provisioning.generateTempPassword).toHaveBeenCalledTimes(1);
      expect(provisioning.credentialFields).toHaveBeenCalledWith(
        'Temp-Pass-9xZ!',
        { mustChangePassword: true },
      );
      // The row is updated WITH the credential fields AND directoryOnly=false — and NOTHING else. No role
      // (no privilege widening) and no sessionEpoch bump (a directory person holds no session to revoke).
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'uuid-onb' },
        data: {
          passwordHash: '$argon2id$hash',
          passwordUpdatedAt: new Date('2026-07-03T00:00:00.000Z'),
          mustChangePassword: true,
          directoryOnly: false,
        },
      });
      const updateArg = (
        user.update.mock.calls as Array<[{ data: Record<string, unknown> }]>
      )[0][0];
      expect(updateArg.data).not.toHaveProperty('role');
      expect(updateArg.data).not.toHaveProperty('sessionEpoch');
      // The transition is audited (UPDATED, no new enum) in the SAME tx, with the onboarding action payload.
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'uuid-onb',
        eventType: 'UPDATED',
        payload: { action: 'provisionLocalAccount', directoryOnly: false },
        actor: { userId: 'admin-1' },
      });
      // The plaintext is returned to the admin ONCE (AdminPasswordResetResult shape).
      expect(result).toEqual({ temporaryPassword: 'Temp-Pass-9xZ!' });
    });

    it('400 when the target is NOT a directory person (already a real account) — mints nothing', async () => {
      user.findFirst.mockResolvedValue({ ...DIRECTORY, directoryOnly: false });

      await expect(
        service.provisionLocalAccount('uuid-onb', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });

    it('400 in OIDC mode — no credential is ever minted (invariant not bypassed)', async () => {
      process.env.AUTH_MODE = 'oidc';
      user.findFirst.mockResolvedValue(DIRECTORY);

      await expect(
        service.provisionLocalAccount('uuid-onb', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });

    it('404 when the person is missing or soft-deleted (findOne filters) — mints nothing', async () => {
      user.findFirst.mockResolvedValue(null);

      await expect(
        service.provisionLocalAccount('missing', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
    });
  });

  // SEC-006: externalId is no longer a client-settable create field (it is server-owned, ADR-0016).
  // The schema-level guard is covered by packages/shared user.test.ts; the service just forwards the
  // (already-validated) payload to Prisma, asserted by the case above.

  it('returns a user by id when it exists', async () => {
    const found = { id: 'uuid-1', email: 'a@b.com', deletedAt: null };
    user.findFirst.mockResolvedValue(found);

    await expect(service.findOne('uuid-1')).resolves.toEqual(found);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
    });
  });

  it('throws NotFound when the user does not exist', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('offboards: soft-deletes (deletedAt) + revokes grants + releases assignments, in one tx', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
    tx.accessGrant.updateMany.mockResolvedValue({ count: 2 });
    assignments.releaseAllForUser.mockResolvedValue([
      { id: 'assign-1', assetId: 'asset-1' },
    ]);

    const result = await service.remove('uuid-1', { userId: 'actor-99' });

    // Soft delete = an UPDATE that stamps deletedAt, never a hard delete().
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    const updateCalls = tx.user.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(updateCalls[0][0].where).toEqual({ id: 'uuid-1' });
    expect(updateCalls[0][0].data.deletedAt).toBeInstanceOf(Date);
    // Offboarding revokes every local session, so a later restore() cannot revive one (ADR-0086 §8).
    expect(updateCalls[0][0].data).toHaveProperty('sessionEpoch', {
      increment: 1,
    });
    // …and every MCP connection / personal token (ADR-0097 decision 8, amended 2026-09-24).
    expect(updateCalls[0][0].data).toHaveProperty('mcpCredentialEpoch', {
      increment: 1,
    });

    // Active grants are revoked inline (revokedAt + actor + audit note).
    const grantCalls = tx.accessGrant.updateMany.mock.calls as Array<
      [
        {
          where: { userId: string; revokedAt: null };
          data: {
            revokedAt: Date;
            revokedById?: string;
            revokedBySaId?: string;
            notes: string;
          };
        },
      ]
    >;
    expect(grantCalls[0][0].where).toEqual({
      userId: 'uuid-1',
      revokedAt: null,
    });
    expect(grantCalls[0][0].data.revokedAt).toBeInstanceOf(Date);
    // A human offboarder → revokedById, never revokedBySaId (behavior-preserving; ADR-0048).
    expect(grantCalls[0][0].data.revokedById).toBe('actor-99');
    expect(grantCalls[0][0].data).not.toHaveProperty('revokedBySaId');
    expect(grantCalls[0][0].data.notes).toBe('auto: offboarded');

    // Active assignments are released through the bulk helper with the resolved attribution.
    expect(assignments.releaseAllForUser).toHaveBeenCalledWith(tx, 'uuid-1', {
      userId: 'actor-99',
    });

    // Soft-delete drops the user from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('users', 'uuid-1');

    // The offboarding summary is returned. This user held no vault membership (the default), so the
    // #869 fields are the empty base case: no crypto access revoked, no vaults to rotate.
    expect(result).toEqual({
      userId: 'uuid-1',
      releasedAssignments: [{ id: 'assign-1', assetId: 'asset-1' }],
      revokedGrants: 2,
      revokedVaultMemberships: 0,
      rotationVaults: [],
    });
    // With no membership, we neither delete rows nor write an audit row (skip the empty createMany).
    expect(tx.vaultMembership.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'uuid-1' },
    });
    expect(tx.secretAuditLog.createMany).not.toHaveBeenCalled();

    // DEBT-2 (issue #185): a DELETED UserHistory row is appended inside the SAME transaction, with the
    // full actor attribution (human → { userId }) on the SUBJECT being offboarded.
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(tx, {
      userId: 'uuid-1',
      eventType: 'DELETED',
      actor: { userId: 'actor-99' },
    });
  });

  // Issue #869 — offboarding also revokes the departing user's Secret-vault crypto memberships (a SOC2
  // offboarding-control gap) and flags each vault to rotate. INV-10-safe: a pure row-delete of wrapped
  // key material; no decryption. Reuses the offboard setup above.
  it('offboards: revokes ALL the user’s vault memberships and flags each vault to rotate (#869)', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
    tx.accessGrant.updateMany.mockResolvedValue({ count: 0 });
    // The user is a crypto member of two vaults; the read carries each vault's name + LIVE item count.
    tx.vaultMembership.findMany.mockResolvedValue([
      { vaultId: 'vault-a', vault: { name: 'Prod DB', _count: { items: 3 } } },
      { vaultId: 'vault-b', vault: { name: 'API keys', _count: { items: 0 } } },
    ]);
    tx.vaultMembership.deleteMany.mockResolvedValue({ count: 2 });

    const result = await service.remove('uuid-1', { userId: 'actor-99' });

    // The rotation list is read BEFORE the delete (the rows vanish after), scoped to only LIVE items.
    expect(tx.vaultMembership.findMany).toHaveBeenCalledWith({
      where: { userId: 'uuid-1' },
      select: {
        vaultId: true,
        vault: {
          select: {
            name: true,
            _count: { select: { items: { where: { deletedAt: null } } } },
          },
        },
      },
    });
    // ALL of the user's memberships are hard-dropped (deleteMany — no soft-delete/deletedAt column).
    expect(tx.vaultMembership.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'uuid-1' },
    });

    // (a) the count revoked + (b) the rotation prompt (vault name + live item count per vault).
    expect(result.revokedVaultMemberships).toBe(2);
    expect(result.rotationVaults).toEqual([
      { vaultId: 'vault-a', name: 'Prod DB', itemCount: 3 },
      { vaultId: 'vault-b', name: 'API keys', itemCount: 0 },
    ]);

    // (c) audit parity: one MEMBERSHIP_REVOKED row per revoked vault, targetUserId = the offboarded
    // user, and a HUMAN offboarder → actorId (never serviceAccountId; the CHECK enforces exactly one).
    expect(tx.secretAuditLog.createMany).toHaveBeenCalledTimes(1);
    const auditCalls = tx.secretAuditLog.createMany.mock.calls as Array<
      [{ data: Array<Record<string, unknown>> }]
    >;
    const auditArg = auditCalls[0][0];
    expect(auditArg.data).toEqual([
      {
        action: 'MEMBERSHIP_REVOKED',
        vaultId: 'vault-a',
        targetUserId: 'uuid-1',
        actorId: 'actor-99',
      },
      {
        action: 'MEMBERSHIP_REVOKED',
        vaultId: 'vault-b',
        targetUserId: 'uuid-1',
        actorId: 'actor-99',
      },
    ]);
    for (const row of auditArg.data) {
      expect(row).not.toHaveProperty('serviceAccountId');
    }
  });

  it('attributes the vault-revoke audit rows to the SERVICE ACCOUNT when a SA offboards (#869)', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
    tx.vaultMembership.findMany.mockResolvedValue([
      { vaultId: 'vault-a', vault: { name: 'Prod DB', _count: { items: 1 } } },
    ]);
    tx.vaultMembership.deleteMany.mockResolvedValue({ count: 1 });

    await service.remove('uuid-1', { serviceAccountId: 'sa-7' });

    const auditCalls = tx.secretAuditLog.createMany.mock.calls as Array<
      [{ data: Array<Record<string, unknown>> }]
    >;
    const auditArg = auditCalls[0][0];
    // A SA offboarder → serviceAccountId, never actorId (mirrors the grant-revoke branch; ADR-0048).
    expect(auditArg.data).toEqual([
      {
        action: 'MEMBERSHIP_REVOKED',
        vaultId: 'vault-a',
        targetUserId: 'uuid-1',
        serviceAccountId: 'sa-7',
      },
    ]);
    expect(auditArg.data[0]).not.toHaveProperty('actorId');
  });

  it('offboarding an IdP-linked user makes no IdP call; lazyit still soft-deletes it (ADR-0102 §5)', async () => {
    user.findFirst.mockResolvedValue({
      id: 'uuid-1',
      role: 'MEMBER',
      externalId: 'oidc-sub-9',
      deletedAt: null,
    });
    tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
    tx.accessGrant.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.remove('uuid-1', { userId: 'actor-99' }),
    ).resolves.toMatchObject({ userId: 'uuid-1' });

    // Disabling the IdP account is the operator's step; nothing inside the transaction is a network call.
    const updateCalls = tx.user.update.mock.calls as Array<
      [{ data: { deletedAt: Date } }]
    >;
    expect(updateCalls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(history.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ userId: 'uuid-1', eventType: 'DELETED' }),
    );
  });

  it('does not offboard a user that is missing', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.accessGrant.updateMany).not.toHaveBeenCalled();
    expect(assignments.releaseAllForUser).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  // ADR-0086 §8 (#1307): deactivation revokes every local session, so a later reactivation cannot revive a
  // token minted before it (a "keep me signed in" token never expires by time).
  describe('session revocation on deactivation (ADR-0086 §8)', () => {
    type UpdateCall = [{ data: Record<string, unknown> }];

    it('bumps sessionEpoch and mcpCredentialEpoch when an active user is deactivated', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: false });

      await service.update('uuid-1', { isActive: false });

      const [[arg]] = user.update.mock.calls as UpdateCall[];
      expect(arg.data).toMatchObject({
        isActive: false,
        sessionEpoch: { increment: 1 },
        mcpCredentialEpoch: { increment: 1 },
      });
    });

    it('does not bump sessionEpoch on reactivation, a repeat deactivation, or a profile edit', async () => {
      user.update.mockResolvedValue({ id: 'uuid-1' });

      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: false,
        deletedAt: null,
      });
      await service.update('uuid-1', { isActive: true });
      await service.update('uuid-1', { isActive: false });

      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        lastName: 'Lovelace',
        deletedAt: null,
      });
      await service.update('uuid-1', { lastName: 'Byron' });

      for (const [arg] of user.update.mock.calls as UpdateCall[]) {
        expect(arg.data).not.toHaveProperty('sessionEpoch');
        expect(arg.data).not.toHaveProperty('mcpCredentialEpoch');
      }
    });
  });

  // A sync-offboarded person re-enabled by an admin keeps the stamp; a later manual deactivation must drop it.
  describe('manual deactivation vs. the directory offboard stamp (#1311)', () => {
    type UpdateCall = [{ data: Record<string, unknown> }];

    it('clears directoryOffboardedAt when an active user is deactivated by hand', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        directoryOffboardedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: false });

      await service.update('uuid-1', { isActive: false });

      const [[arg]] = user.update.mock.calls as UpdateCall[];
      expect(arg.data).toMatchObject({
        isActive: false,
        directoryOffboardedAt: null,
      });
    });

    it('leaves the stamp alone on a reactivation or a profile edit', async () => {
      user.update.mockResolvedValue({ id: 'uuid-1' });

      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: false,
        directoryOffboardedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      });
      await service.update('uuid-1', { isActive: true });

      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        lastName: 'Lovelace',
        deletedAt: null,
      });
      await service.update('uuid-1', { lastName: 'Byron' });

      for (const [arg] of user.update.mock.calls as UpdateCall[]) {
        expect(arg.data).not.toHaveProperty('directoryOffboardedAt');
      }
    });
  });

  // An admin's re-enable must hold against the directory sweep while the person stays absent from AD.
  describe('manual re-enable vs. the directory sweep (#1522)', () => {
    type UpdateCall = [{ data: Record<string, unknown> }];

    it('marks directoryReenabledAt when an inactive user is re-enabled by hand', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: false,
        directoryReenabledAt: null,
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: true });

      await service.update('uuid-1', { isActive: true });

      const [[arg]] = user.update.mock.calls as UpdateCall[];
      expect(arg.data.isActive).toBe(true);
      expect(arg.data.directoryReenabledAt).toBeInstanceOf(Date);
    });

    it('clears the mark when an active user is deactivated by hand', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        directoryReenabledAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: false });

      await service.update('uuid-1', { isActive: false });

      const [[arg]] = user.update.mock.calls as UpdateCall[];
      expect(arg.data).toMatchObject({
        isActive: false,
        directoryReenabledAt: null,
      });
    });

    it('does not write the mark on a no-op activation or a profile edit', async () => {
      user.update.mockResolvedValue({ id: 'uuid-1' });
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        lastName: 'Lovelace',
        deletedAt: null,
      });

      await service.update('uuid-1', { isActive: true });
      await service.update('uuid-1', { lastName: 'Byron' });

      for (const [arg] of user.update.mock.calls as UpdateCall[]) {
        expect(arg.data).not.toHaveProperty('directoryReenabledAt');
      }
    });
  });

  // Issue #1375: an activation flip used to change silently — no UserHistory row, so it never reached
  // the recent_activity view (Reports → Users). Every route (web UI, API, AI tool call) lands here.
  describe('activation + identifier audit (issue #1375)', () => {
    const ACTOR = 'actor-uuid';

    it('records DEACTIVATED with the actor when an active user is deactivated', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        role: 'MEMBER',
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: false });

      await service.update('uuid-1', { isActive: false }, ACTOR);

      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'uuid-1',
        eventType: 'DEACTIVATED',
        actor: { userId: ACTOR },
      });
    });

    it('records REACTIVATED when an inactive user is re-enabled', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: false,
        role: 'MEMBER',
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: true });

      await service.update('uuid-1', { isActive: true }, ACTOR);

      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ eventType: 'REACTIVATED' }),
      );
    });

    it('records nothing when isActive is resent unchanged', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        role: 'MEMBER',
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1', isActive: true });

      await service.update('uuid-1', { isActive: true }, ACTOR);

      expect(history.record).not.toHaveBeenCalled();
    });

    it('records UPDATED { fields } for a legajo / username change, not for a resend', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        isActive: true,
        role: 'MEMBER',
        legajo: 'L-1',
        username: null,
        deletedAt: null,
      });
      user.update.mockResolvedValue({ id: 'uuid-1' });

      await service.update('uuid-1', { legajo: 'L-2', username: 'ada' }, ACTOR);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'uuid-1',
        eventType: 'UPDATED',
        payload: { fields: ['legajo', 'username'] },
        actor: { userId: ACTOR },
      });

      history.record.mockClear();
      await service.update('uuid-1', { legajo: 'L-1', username: null }, ACTOR);
      expect(history.record).not.toHaveBeenCalled();
    });
  });

  it('re-indexes the user on update (upsert with the updated row)', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    user.update.mockResolvedValue({
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Byron',
      email: 'a@b.com',
    });

    await service.update('uuid-1', { lastName: 'Byron' });

    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Byron',
      email: 'a@b.com',
    });
  });

  // ADR-0040 RBAC safety guards — last-admin protection + no self-role-change.
  describe('updateOwnProfile — PATCH /users/me (issue #1421)', () => {
    const SELF = {
      id: 'self-1',
      firstName: 'Old',
      lastName: 'Name',
      email: 'me@b.com',
      role: 'VIEWER',
      isActive: true,
      externalId: null,
      directoryOnly: false,
      directorySource: null,
      deletedAt: null,
    };

    it('renames the caller and records UPDATED { fields: [name] } with the caller as actor', async () => {
      user.findFirst.mockResolvedValue(SELF);
      user.update.mockResolvedValue({ ...SELF, firstName: 'New' });

      await service.updateOwnProfile(SELF as never, { firstName: 'New' });

      // Only the name keys reach the write — never role / email / activation.
      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'self-1' },
          data: { firstName: 'New' },
        }),
      );
      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'self-1',
        eventType: 'UPDATED',
        payload: { fields: ['name'] },
        actor: { userId: 'self-1' },
      });
      expect(search.upsert).toHaveBeenCalled();
    });

    it('reads the CURRENT row, not the request snapshot, before deciding', async () => {
      user.findFirst.mockResolvedValue(SELF);
      user.update.mockResolvedValue(SELF);
      await service.updateOwnProfile(SELF as never, { lastName: 'Name' });
      expect(user.findFirst).toHaveBeenCalledWith({ where: { id: 'self-1' } });
      // Resending the stored value is not a change: no history row.
      expect(history.record).not.toHaveBeenCalled();
    });

    it('refuses (409 PROFILE_MANAGED_BY_DIRECTORY) a person the AD/LDAP sync owns', async () => {
      user.findFirst.mockResolvedValue({ ...SELF, directorySource: 'ad' });

      const err = await service
        .updateOwnProfile(SELF as never, { firstName: 'New' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'PROFILE_MANAGED_BY_DIRECTORY' }),
      );
      expect(user.update).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });

    it('refuses a directory-only person the same way', async () => {
      user.findFirst.mockResolvedValue({ ...SELF, directoryOnly: true });
      await expect(
        service.updateOwnProfile(SELF as never, { firstName: 'New' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('persists the new name for an IdP-linked user without writing to the IdP (ADR-0102)', async () => {
      const linked = { ...SELF, externalId: 'sub-1' };
      user.findFirst.mockResolvedValue(linked);
      user.update.mockResolvedValue({ ...linked, lastName: 'Newer' });

      await service.updateOwnProfile(linked as never, { lastName: 'Newer' });

      expect(user.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('role-change guards (ADR-0040)', () => {
    it('forbids a user from changing their OWN role (403)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        role: 'ADMIN',
        deletedAt: null,
      });

      // actorId === target id → self-change is rejected before any DB write.
      await expect(
        service.update('uuid-1', { role: 'MEMBER' }, 'uuid-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('refuses to demote the LAST remaining ADMIN (409)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      // No OTHER admin exists → this is the final administrator.
      user.count.mockResolvedValue(0);

      await expect(
        service.update('admin-1', { role: 'MEMBER' }, 'actor-99'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(user.count).toHaveBeenCalledWith({
        where: { role: 'ADMIN', isActive: true, id: { not: 'admin-1' } },
      });
      expect(user.update).not.toHaveBeenCalled();
    });

    it('allows demoting an admin when another admin remains', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(2); // other admins exist
      user.update.mockResolvedValue({
        id: 'admin-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
      });

      await expect(
        service.update('admin-1', { role: 'MEMBER' }, 'actor-99'),
      ).resolves.toMatchObject({ role: 'MEMBER' });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { role: 'MEMBER' },
      });

      // DEBT-2 (issue #185): a role change appends a ROLE_CHANGED UserHistory row carrying { from, to }
      // and the human actor, on the SUBJECT whose role changed. (No profile change → no UPDATED row.)
      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'admin-1',
        eventType: 'ROLE_CHANGED',
        payload: { from: 'ADMIN', to: 'MEMBER' },
        actor: { userId: 'actor-99' },
      });
    });

    it('allows promoting a member to admin without touching the last-admin guard', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        role: 'MEMBER',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'ADMIN',
      });

      await service.update('member-1', { role: 'ADMIN' }, 'actor-99');
      // Promotion is not a demotion-away-from-ADMIN, so the count guard never runs.
      expect(user.count).not.toHaveBeenCalled();
      expect(user.update).toHaveBeenCalled();
    });

    it('skips the guards for a non-role update (e.g. name change)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'admin-1',
        firstName: 'New',
        lastName: 'Name',
        email: 'a@b.com',
        role: 'ADMIN',
      });

      // Same actor as the target, but no role field → self-guard must NOT trip.
      await service.update('admin-1', { firstName: 'New' }, 'admin-1');
      expect(user.count).not.toHaveBeenCalled();
      expect(user.update).toHaveBeenCalled();

      // DEBT-2 (issue #185): a name edit appends an UPDATED UserHistory row recording WHICH fields
      // changed (names only, never the values), attributed to the actor (here a self-edit: actor === id).
      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'admin-1',
        eventType: 'UPDATED',
        payload: { fields: ['name'] },
        actor: { userId: 'admin-1' },
      });
    });

    it('refuses to offboard the LAST remaining ADMIN (409)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(0); // the only admin

      await expect(
        service.remove('admin-1', { userId: 'actor-99' }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The transaction never runs — nothing is soft-deleted or revoked.
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.accessGrant.updateMany).not.toHaveBeenCalled();
    });

    it('offboards an admin when another admin remains', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(1); // a second admin remains
      tx.user.update.mockResolvedValue({
        id: 'admin-1',
        deletedAt: new Date(),
      });

      await expect(
        service.remove('admin-1', { userId: 'actor-99' }),
      ).resolves.toMatchObject({
        userId: 'admin-1',
      });
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });

    // SEC-021: an inactive account cannot authenticate, so deactivating an ADMIN strips its
    // administrator powers exactly like a demotion — and an inactive ADMIN never counts as the admin
    // that keeps the instance administrable.
    describe('last-admin guard vs isActive (SEC-021)', () => {
      // Simulates an instance where one OTHER admin row exists but is deactivated: a count that does not
      // filter on isActive sees it (1); a count restricted to active admins does not (0).
      const onlyAnInactiveOtherAdmin = ({
        where,
      }: {
        where: Record<string, unknown>;
      }) => Promise.resolve(where.isActive === true ? 0 : 1);

      it('refuses to deactivate the LAST active ADMIN (409), including yourself', async () => {
        user.findFirst.mockResolvedValue({
          id: 'admin-1',
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        });
        user.count.mockResolvedValue(0); // no other admin at all

        await expect(
          service.update('admin-1', { isActive: false }, 'admin-1'),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          service.update('admin-1', { isActive: false }, 'actor-99'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(user.update).not.toHaveBeenCalled();
      });

      it('allows deactivating an admin when another active admin remains', async () => {
        user.findFirst.mockResolvedValue({
          id: 'admin-1',
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        });
        user.count.mockResolvedValue(1);
        user.update.mockResolvedValue({ id: 'admin-1', isActive: false });

        await service.update('admin-1', { isActive: false }, 'actor-99');
        expect(user.update).toHaveBeenCalledTimes(1);
      });

      it('never consults the guard when deactivating a non-admin or re-sending isActive=false', async () => {
        user.update.mockResolvedValue({ id: 'u' });

        user.findFirst.mockResolvedValue({
          id: 'member-1',
          role: 'MEMBER',
          isActive: true,
          deletedAt: null,
        });
        await service.update('member-1', { isActive: false }, 'actor-99');

        user.findFirst.mockResolvedValue({
          id: 'admin-2',
          role: 'ADMIN',
          isActive: false,
          deletedAt: null,
        });
        await service.update('admin-2', { isActive: false }, 'actor-99');

        expect(user.count).not.toHaveBeenCalled();
        expect(user.update).toHaveBeenCalledTimes(2);
      });

      it('refuses to deactivate an admin whose only fellow admin is already inactive (409)', async () => {
        user.findFirst.mockResolvedValue({
          id: 'admin-1',
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        });
        user.count.mockImplementation(onlyAnInactiveOtherAdmin);

        await expect(
          service.update('admin-1', { isActive: false }, 'actor-99'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(user.update).not.toHaveBeenCalled();
      });

      it('refuses to demote an admin whose only fellow admin is inactive (409)', async () => {
        user.findFirst.mockResolvedValue({
          id: 'admin-1',
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        });
        user.count.mockImplementation(onlyAnInactiveOtherAdmin);

        await expect(
          service.update('admin-1', { role: 'MEMBER' }, 'actor-99'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(user.update).not.toHaveBeenCalled();
      });

      it('refuses to offboard an admin whose only fellow admin is inactive (409)', async () => {
        user.findFirst.mockResolvedValue({
          id: 'admin-1',
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        });
        user.count.mockImplementation(onlyAnInactiveOtherAdmin);

        await expect(
          service.remove('admin-1', { userId: 'actor-99' }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(tx.user.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('serializeUser — UI preferences (issue #1422)', () => {
    const ROW = {
      id: 'u-1',
      firstName: 'A',
      lastName: 'B',
      managerId: null,
      managerName: null,
    };

    it('carries locale/theme, null when never chosen', async () => {
      await expect(
        service.serializeUser({ ...ROW, locale: null, theme: null } as never),
      ).resolves.toEqual(
        expect.objectContaining({ locale: null, theme: null }),
      );
      await expect(
        service.serializeUser({ ...ROW, locale: 'es', theme: 'dark' } as never),
      ).resolves.toEqual(
        expect.objectContaining({ locale: 'es', theme: 'dark' }),
      );
    });

    it('reads an unknown stored value as null (tolerant read)', async () => {
      await expect(
        service.serializeUser({ ...ROW, locale: 'fr', theme: 'x' } as never),
      ).resolves.toEqual(
        expect.objectContaining({ locale: null, theme: null }),
      );
    });
  });

  describe('findPage', () => {
    it('defaults to createdAt desc, scopes to live users, and returns the Page envelope', async () => {
      user.findMany.mockResolvedValue([{ id: 'u1' }]);
      user.count.mockResolvedValue(1);

      const page = await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'active' },
      );

      expect(user.findMany).toHaveBeenCalledWith({
        // The default `active` slice scopes the list to live users (ADR-0041).
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        skip: 0,
      });
      expect(page).toEqual({
        // The list items are SERIALIZED (ADR-0058): each gains a resolved `manager` (null here) and the
        // #386 list-only activity counts (default 0 here — the groupBy mocks return no rows).
        items: [
          {
            id: 'u1',
            manager: null,
            locale: null,
            theme: null,
            assetsInPossession: 0,
            appAccesses: 0,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it('applies a case-insensitive q over firstName/lastName/email', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        { q: 'bob' },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { firstName: { contains: 'bob', mode: 'insensitive' } },
              { lastName: { contains: 'bob', mode: 'insensitive' } },
              { email: { contains: 'bob', mode: 'insensitive' } },
            ],
          },
        ],
        deletedAt: null,
      });
    });

    it('requires every token of a multi-word q to match some field (issue #1053)', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        { q: 'Nahuel Genari' },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { firstName: { contains: 'Nahuel', mode: 'insensitive' } },
              { lastName: { contains: 'Nahuel', mode: 'insensitive' } },
              { email: { contains: 'Nahuel', mode: 'insensitive' } },
            ],
          },
          {
            OR: [
              { firstName: { contains: 'Genari', mode: 'insensitive' } },
              { lastName: { contains: 'Genari', mode: 'insensitive' } },
              { email: { contains: 'Genari', mode: 'insensitive' } },
            ],
          },
        ],
        deletedAt: null,
      });
    });

    it('honors an allowlisted sort and rejects an unknown one (400)', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'email', dir: 'asc', deleted: 'active' },
      );
      const call = (
        user.findMany.mock.calls as Array<
          [{ orderBy: Record<string, unknown> }]
        >
      )[0][0];
      expect(call.orderBy).toEqual({ email: 'asc' });

      await expect(
        service.findPage(
          {},
          {
            limit: 50,
            offset: 0,
            sort: 'password',
            dir: 'asc',
            deleted: 'active',
          },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deleted=only returns soft-deleted (offboarded) users via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
      user.findMany.mockResolvedValue([{ id: 'gone' }]);
      user.count.mockResolvedValue(1);

      const page = await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'only' },
      );

      expect(user.findMany).toHaveBeenCalledWith({
        where: { deletedAt: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        skip: 0,
        includeSoftDeleted: true,
      });
      expect(user.count).toHaveBeenCalledWith({
        where: { deletedAt: { not: null } },
        includeSoftDeleted: true,
      });
      expect(page.items).toEqual([
        {
          id: 'gone',
          manager: null,
          locale: null,
          theme: null,
          assetsInPossession: 0,
          appAccesses: 0,
        },
      ]);
    });

    // Issue #961 — the batch id→name resolver filter. `ids` scopes the page to exactly the requested
    // ids via `id: { in }`, alongside the default live-user slice; unknown ids simply match nothing.
    it('scopes to the requested ids via id: { in } (batch resolver, #961)', async () => {
      user.findMany.mockResolvedValue([
        { id: '11111111-1111-4111-8111-111111111111' },
      ]);
      user.count.mockResolvedValue(1);

      const ids = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ];
      await service.findPage(
        { ids },
        { limit: 200, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      // Only the requested ids are queried (an unknown id in the set matches no row — silently ignored),
      // still scoped to the live slice.
      expect(call.where).toEqual({ id: { in: ids }, deletedAt: null });
    });

    it('omits the id filter entirely for an empty ids array', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        { ids: [] },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toEqual({ deletedAt: null });
    });

    // Issue #386 — the two derived, list-only activity counts. They must be BATCHED per page (one
    // `groupBy` each over the whole page's user ids, never N+1) and reflect only the ACTIVE lifecycle.
    describe('activity counts (#386)', () => {
      it('attaches assetsInPossession / appAccesses from one groupBy per count, batched over the page', async () => {
        user.findMany.mockResolvedValue([
          { id: 'u1' },
          { id: 'u2' },
          { id: 'u3' },
        ]);
        user.count.mockResolvedValue(3);
        // u1 holds 2 assets, u2 holds 1; u3 holds none (absent from the result → defaults to 0).
        prismaMock.assetAssignment.groupBy.mockResolvedValue([
          { userId: 'u1', _count: { _all: 2 } },
          { userId: 'u2', _count: { _all: 1 } },
        ]);
        // u1 has 3 app grants, u3 has 1; u2 has none (absent → 0).
        prismaMock.accessGrant.groupBy.mockResolvedValue([
          { userId: 'u1', _count: { _all: 3 } },
          { userId: 'u3', _count: { _all: 1 } },
        ]);

        const page = await service.findPage(
          {},
          { limit: 50, offset: 0, deleted: 'active' },
        );

        expect(page.items).toEqual([
          {
            id: 'u1',
            manager: null,
            locale: null,
            theme: null,
            assetsInPossession: 2,
            appAccesses: 3,
          },
          {
            id: 'u2',
            manager: null,
            locale: null,
            theme: null,
            assetsInPossession: 1,
            appAccesses: 0,
          },
          {
            id: 'u3',
            manager: null,
            locale: null,
            theme: null,
            assetsInPossession: 0,
            appAccesses: 1,
          },
        ]);

        // BATCHING PROOF: each count is exactly ONE groupBy for the WHOLE 3-row page — not one per row.
        expect(prismaMock.assetAssignment.groupBy).toHaveBeenCalledTimes(1);
        expect(prismaMock.accessGrant.groupBy).toHaveBeenCalledTimes(1);
      });

      it('counts ACTIVE assignments/grants only (releasedAt: null / revokedAt: null), grouped by userId over the page', async () => {
        user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
        user.count.mockResolvedValue(2);

        await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

        // Assets-in-possession = active assignments (ADR-0019): releasedAt IS NULL, scoped to the page.
        expect(prismaMock.assetAssignment.groupBy).toHaveBeenCalledWith({
          by: ['userId'],
          where: { userId: { in: ['u1', 'u2'] }, releasedAt: null },
          _count: { _all: true },
        });
        // App-accesses = active grants (ADR-0023): revokedAt IS NULL, scoped to the page.
        expect(prismaMock.accessGrant.groupBy).toHaveBeenCalledWith({
          by: ['userId'],
          where: { userId: { in: ['u1', 'u2'] }, revokedAt: null },
          _count: { _all: true },
        });
      });

      it('skips the count queries entirely for an empty page (no ids to aggregate)', async () => {
        user.findMany.mockResolvedValue([]);
        user.count.mockResolvedValue(0);

        const page = await service.findPage(
          {},
          { limit: 50, offset: 0, deleted: 'active' },
        );

        expect(page.items).toEqual([]);
        // No user ids on the page → neither groupBy is issued (zero wasted queries).
        expect(prismaMock.assetAssignment.groupBy).not.toHaveBeenCalled();
        expect(prismaMock.accessGrant.groupBy).not.toHaveBeenCalled();
      });
    });

    // ADR-0069 REDESIGN §0 #2 — directoryOnly filter
    it('directoryOnly=true scopes where to { directoryOnly: true }', async () => {
      user.findMany.mockResolvedValue([{ id: 'dir-1' }]);
      user.count.mockResolvedValue(1);

      await service.findPage(
        { directoryOnly: true },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toMatchObject({ directoryOnly: true });
    });

    it('directoryOnly=false scopes where to { directoryOnly: false }', async () => {
      user.findMany.mockResolvedValue([{ id: 'login-1' }]);
      user.count.mockResolvedValue(1);

      await service.findPage(
        { directoryOnly: false },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toMatchObject({ directoryOnly: false });
    });

    it('absent directoryOnly adds no directoryOnly clause (shows all users)', async () => {
      user.findMany.mockResolvedValue([{ id: 'any-1' }]);
      user.count.mockResolvedValue(1);

      await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).not.toHaveProperty('directoryOnly');
    });

    // issue #693 — the RBAC role filter (backs the Roles "View N members" deep-link).
    it('role scopes both the findMany and the paired count where to { role }', async () => {
      user.findMany.mockResolvedValue([{ id: 'v1' }]);
      user.count.mockResolvedValue(1);

      await service.findPage(
        { role: 'VIEWER' },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const findCall = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      const countCall = (
        user.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      // The same where (role + live slice) drives the page and its total, so the count is authoritative.
      expect(findCall.where).toMatchObject({ role: 'VIEWER', deletedAt: null });
      expect(countCall.where).toMatchObject({
        role: 'VIEWER',
        deletedAt: null,
      });
    });

    it('absent role adds no role clause (shows all roles)', async () => {
      user.findMany.mockResolvedValue([{ id: 'any-1' }]);
      user.count.mockResolvedValue(1);

      await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).not.toHaveProperty('role');
    });

    // issue #1375 — the activation filter ("list the deactivated users" in one call).
    it('isActive scopes both the findMany and the count; absent adds no clause', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        { isActive: false },
        { limit: 50, offset: 0, deleted: 'active' },
      );
      await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

      const finds = user.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >;
      const counts = user.count.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >;
      expect(finds[0][0].where).toMatchObject({ isActive: false });
      expect(counts[0][0].where).toMatchObject({ isActive: false });
      expect(finds[1][0].where).not.toHaveProperty('isActive');
    });
  });

  // issue #693 — per-role LIVE counts for the Settings → Roles cards. ONE groupBy over the live
  // directory, exhaustive over the role enum (a role with no holders is 0, never absent).
  describe('roleCounts (#693)', () => {
    it('returns one groupBy result per role, scoped to live users, defaulting missing roles to 0', async () => {
      // VIEWER has no holders → absent from the groupBy result → must default to 0 below.
      user.groupBy.mockResolvedValue([
        { role: 'ADMIN', _count: { _all: 2 } },
        { role: 'MEMBER', _count: { _all: 5 } },
      ]);

      const counts = await service.roleCounts();

      expect(counts).toEqual({ ADMIN: 2, MEMBER: 5, VIEWER: 0 });
      // ONE query (never one-per-role), grouped by role over the ACTIVE (not soft-deleted) directory.
      expect(user.groupBy).toHaveBeenCalledTimes(1);
      expect(user.groupBy).toHaveBeenCalledWith({
        by: ['role'],
        where: { deletedAt: null },
        _count: { _all: true },
      });
    });

    it('returns all-zero when the directory is empty (every role key still present)', async () => {
      user.groupBy.mockResolvedValue([]);

      const counts = await service.roleCounts();

      expect(counts).toEqual({ ADMIN: 0, MEMBER: 0, VIEWER: 0 });
    });
  });

  // ADR-0102 — no IdP write-back: an edit of an IdP-linked user is a plain database write.
  describe('no IdP write-back (ADR-0102)', () => {
    const LINKED = {
      id: 'member-1',
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.com',
      role: 'MEMBER',
      isActive: true,
      externalId: 'oidc-sub-9',
      managerId: null,
      managerName: null,
      deletedAt: null,
    };

    it('a role + name + email edit of a linked user persists in one write, with no IdP call', async () => {
      user.findFirst.mockResolvedValue(LINKED);
      user.update.mockResolvedValue({
        ...LINKED,
        role: 'ADMIN',
        firstName: 'New',
        email: 'new@b.com',
      });

      const result = await service.update(
        'member-1',
        { role: 'ADMIN', firstName: 'New', email: 'new@b.com' },
        'actor-99',
      );

      expect(user.update).toHaveBeenCalledTimes(1);
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        data: { role: 'ADMIN', firstName: 'New', email: 'new@b.com' },
      });
      expect(result).toMatchObject({
        role: 'ADMIN',
        firstName: 'New',
        email: 'new@b.com',
        externalId: 'oidc-sub-9',
      });
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'member-1',
        eventType: 'ROLE_CHANGED',
        payload: { from: 'MEMBER', to: 'ADMIN' },
        actor: { userId: 'actor-99' },
      });
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'member-1',
        eventType: 'UPDATED',
        payload: { fields: ['name', 'email'] },
        actor: { userId: 'actor-99' },
      });
    });

    it('a deactivation alongside a name change is never reverted (the SEC-022 shape is gone)', async () => {
      user.findFirst.mockResolvedValue(LINKED);
      user.update.mockResolvedValue({
        ...LINKED,
        firstName: 'New',
        isActive: false,
      });

      await service.update(
        'member-1',
        { firstName: 'New', isActive: false },
        'actor-99',
      );

      // One write, no compensating second update that could leave isActive behind.
      expect(user.update).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ eventType: 'DEACTIVATED' }),
      );
    });
  });

  // --- restore (re-onboard) (ADR-0041) -------------------------------------
  describe('restore', () => {
    it('clears deletedAt for a soft-deleted user and re-indexes them', async () => {
      user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
      user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: null });

      const restored = await service.restore('uuid-1');

      // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
      expect(user.findFirst).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        includeSoftDeleted: true,
      });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { deletedAt: null },
      });
      expect(restored.deletedAt).toBeNull();
      expect(search.upsert).toHaveBeenCalledWith('users', expect.anything());

      // DEBT-2 (issue #185): a RESTORED UserHistory row is appended in the SAME tx as clearing
      // deletedAt. Called without a principal here → {} attribution (system/unknown actor).
      expect(history.record).toHaveBeenCalledTimes(1);
      expect(history.record).toHaveBeenCalledWith(tx, {
        userId: 'uuid-1',
        eventType: 'RESTORED',
        actor: {},
      });
    });

    it('is idempotent (no update) when the user is already live', async () => {
      user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });

      await service.restore('uuid-1');

      expect(user.update).not.toHaveBeenCalled();
      // DEBT-2: no state change → no RESTORED history row.
      expect(history.record).not.toHaveBeenCalled();
    });

    it('404s when the user never existed', async () => {
      user.findFirst.mockResolvedValue(null);

      await expect(service.restore('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // Issue #149 / #1268 — the admin password reset. Under OIDC the IdP owns it (ADR-0102 §5).
  describe('requestPasswordReset', () => {
    function linkedActiveUser(overrides: Record<string, unknown> = {}) {
      return {
        id: 'user-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        isActive: true,
        externalId: 'oidc-sub-9',
        deletedAt: null,
        ...overrides,
      };
    }

    /** A LOCAL-mode subject: no IdP link by construction (the #1268 bug was gating the UI on this). */
    function localUser(overrides: Record<string, unknown> = {}) {
      return linkedActiveUser({
        externalId: null,
        directoryOnly: false,
        ...overrides,
      });
    }

    it('OIDC: throws PasswordResetUnsupportedError (an honest 501 upstream) and calls no IdP', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser());

      await expect(
        service.requestPasswordReset('user-1', 'actor-1', {
          linkOrigin: 'https://lazyit.example.com',
        }),
      ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);
      // Nothing went out → no PASSWORD_RESET_SENT row, and the credential is untouched.
      expect(history.record).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
    });

    it('OIDC: the same 501 for a user with no externalId and for an explicit delivery choice', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser({ externalId: null }));
      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);

      user.findFirst.mockResolvedValue(linkedActiveUser());
      await expect(
        service.requestPasswordReset('user-1', 'actor-1', {
          delivery: 'email',
        }),
      ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);
      expect(passwordLifecycle.sendAdminResetLink).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });

    it('404s when the user is missing or soft-deleted (findOne filters)', async () => {
      user.findFirst.mockResolvedValue(null);

      await expect(
        service.requestPasswordReset('missing', 'actor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(history.record).not.toHaveBeenCalled();
    });

    it('422s an inactive user', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser({ isActive: false }));

      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    // ADR-0086 §5 (F1c): local mode mints a temp-password directly — no IdP, no 501.
    describe('local mode', () => {
      beforeEach(() => {
        process.env.AUTH_MODE = 'local';
      });

      it('mints + hashes a temp-password, bumps sessionEpoch, audits PASSWORD_RESET_BY_ADMIN, returns the temp password (no IdP call, no 501)', async () => {
        // A local user with NO externalId + NO passwordHash (imported / never provisioned) — the admin
        // reset provisions/resets them. In OIDC mode this would 501; local mints a credential instead.
        user.findFirst.mockResolvedValue(
          linkedActiveUser({ externalId: null, passwordHash: null }),
        );
        user.update.mockResolvedValue(linkedActiveUser());

        const result = await service.requestPasswordReset('user-1', 'actor-1');

        // The temp-password is generated + hashed via the provisioning primitive (forced-change credential).
        expect(provisioning.generateTempPassword).toHaveBeenCalledTimes(1);
        expect(provisioning.credentialFields).toHaveBeenCalledWith(
          'Temp-Pass-9xZ!',
          { mustChangePassword: true },
        );
        // The row is updated with the hashed fields AND a sessionEpoch increment (revoke existing sessions).
        expect(user.update).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          data: {
            passwordHash: '$argon2id$hash',
            passwordUpdatedAt: new Date('2026-07-03T00:00:00.000Z'),
            mustChangePassword: true,
            sessionEpoch: { increment: 1 },
            mcpCredentialEpoch: { increment: 1 },
          },
        });
        // The plaintext is returned to the admin ONCE. Issue #1268 widened this into the delivery
        // outcome; `.temporaryPassword` is still there, so a pre-#1268 web build reading only that field
        // keeps working against a newer API (CLAUDE.md §8).
        expect(result).toEqual({
          delivery: 'temporary-password',
          temporaryPassword: 'Temp-Pass-9xZ!',
          sessionsRevoked: true,
        });
        // NO IdP call in local mode.
        // Append-only audit: PASSWORD_RESET_BY_ADMIN, actor + subject.
        expect(history.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            userId: 'user-1',
            eventType: 'PASSWORD_RESET_BY_ADMIN',
            actor: { userId: 'actor-1' },
          }),
        );
      });

      it('422s a directory-only person (never gets a login credential) and never writes', async () => {
        user.findFirst.mockResolvedValue(
          linkedActiveUser({ externalId: null, directoryOnly: true }),
        );
        await expect(
          service.requestPasswordReset('user-1', 'actor-1'),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(user.update).not.toHaveBeenCalled();
        expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
      });

      it('still 422s an inactive user before minting anything', async () => {
        user.findFirst.mockResolvedValue(
          linkedActiveUser({ isActive: false, externalId: null }),
        );
        await expect(
          service.requestPasswordReset('user-1', 'actor-1'),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
      });

      // ---- issue #1268: the admin picks the delivery ------------------------

      it('an explicit temporary-password delivery takes the SAME path as no body at all', async () => {
        user.findFirst.mockResolvedValue(localUser());
        user.update.mockResolvedValue(localUser());

        const result = await service.requestPasswordReset('user-1', 'actor-1', {
          delivery: 'temporary-password',
        });

        expect(result).toEqual({
          delivery: 'temporary-password',
          temporaryPassword: 'Temp-Pass-9xZ!',
          sessionsRevoked: true,
        });
        expect(passwordLifecycle.sendAdminResetLink).not.toHaveBeenCalled();
      });

      it('ignores revokeSessions:false on the temp-password path — the hash was replaced, so sessions MUST die', async () => {
        user.findFirst.mockResolvedValue(localUser());
        user.update.mockResolvedValue(localUser());

        const result = await service.requestPasswordReset('user-1', 'actor-1', {
          delivery: 'temporary-password',
          revokeSessions: false,
        });

        expect(user.update).toHaveBeenCalledWith({
          where: { id: 'user-1' },
          data: expect.objectContaining({
            sessionEpoch: { increment: 1 },
          }) as unknown,
        });
        expect(result).toMatchObject({ sessionsRevoked: true });
      });

      describe('email delivery', () => {
        it('sends the link, audits PASSWORD_RESET_SENT (actor=admin, subject=user), and does NOT revoke by default', async () => {
          user.findFirst.mockResolvedValue(localUser());
          passwordLifecycle.sendAdminResetLink.mockResolvedValue({
            sentTo: 'a@b.com',
            expiresInMinutes: 60,
          });

          const result = await service.requestPasswordReset(
            'user-1',
            'actor-1',
            { delivery: 'email', linkOrigin: 'https://lazyit.example.com' },
          );

          expect(result).toEqual({
            delivery: 'email',
            sentTo: 'a@b.com',
            expiresInMinutes: 60,
            sessionsRevoked: false,
          });
          expect(passwordLifecycle.sendAdminResetLink).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'user-1', email: 'a@b.com' }),
            'https://lazyit.example.com',
          );
          // Sending a link does not change the stored credential, so live sessions stay valid.
          expect(user.update).not.toHaveBeenCalled();
          // No credential is minted at all on this path — the SUBJECT chooses their own password.
          expect(provisioning.generateTempPassword).not.toHaveBeenCalled();
          expect(history.record).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              userId: 'user-1',
              eventType: 'PASSWORD_RESET_SENT',
              actor: { userId: 'actor-1' },
            }),
          );
        });

        it('bumps sessionEpoch and reports it when revokeSessions is true', async () => {
          user.findFirst.mockResolvedValue(localUser());
          user.update.mockResolvedValue(localUser());

          const result = await service.requestPasswordReset(
            'user-1',
            'actor-1',
            {
              delivery: 'email',
              revokeSessions: true,
              linkOrigin: 'https://lazyit.example.com',
            },
          );

          expect(user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: {
              sessionEpoch: { increment: 1 },
              mcpCredentialEpoch: { increment: 1 },
            },
          });
          expect(result).toMatchObject({ sessionsRevoked: true });
        });

        it.each([
          ['smtp-not-configured' as const],
          ['origin-unknown' as const],
        ])('409s with reason %s and audits NOTHING', async (reason) => {
          user.findFirst.mockResolvedValue(localUser());
          passwordLifecycle.sendAdminResetLink.mockRejectedValue(
            new AdminResetLinkError(reason, 'nope'),
          );

          const err = await service
            .requestPasswordReset('user-1', 'actor-1', { delivery: 'email' })
            .catch((e: unknown) => e);

          expect(err).toBeInstanceOf(ConflictException);
          expect((err as ConflictException).getResponse()).toMatchObject({
            reason,
          });
          // A reset that did not go out is never recorded as one, and nothing is written to the user.
          expect(history.record).not.toHaveBeenCalled();
          expect(user.update).not.toHaveBeenCalled();
        });

        it('503s when the relay refuses, and leaves the account untouched', async () => {
          user.findFirst.mockResolvedValue(localUser());
          passwordLifecycle.sendAdminResetLink.mockRejectedValue(
            new AdminResetLinkError('send-failed', 'relay refused'),
          );

          await expect(
            service.requestPasswordReset('user-1', 'actor-1', {
              delivery: 'email',
              revokeSessions: true,
            }),
          ).rejects.toBeInstanceOf(ServiceUnavailableException);
          // Ordering matters: a failed send must not leave the subject logged out for nothing.
          expect(user.update).not.toHaveBeenCalled();
          expect(history.record).not.toHaveBeenCalled();
        });

        it('422s a directory-only person before any mail is attempted', async () => {
          user.findFirst.mockResolvedValue(localUser({ directoryOnly: true }));
          await expect(
            service.requestPasswordReset('user-1', 'actor-1', {
              delivery: 'email',
            }),
          ).rejects.toBeInstanceOf(UnprocessableEntityException);
          expect(passwordLifecycle.sendAdminResetLink).not.toHaveBeenCalled();
        });

        it('422s an inactive user before any mail is attempted', async () => {
          user.findFirst.mockResolvedValue(localUser({ isActive: false }));
          await expect(
            service.requestPasswordReset('user-1', 'actor-1', {
              delivery: 'email',
            }),
          ).rejects.toBeInstanceOf(UnprocessableEntityException);
          expect(passwordLifecycle.sendAdminResetLink).not.toHaveBeenCalled();
        });
      });
    });
  });

  // Issue #1268 — what the reset dialog may offer, resolved server-side (GET /users/password-reset-capabilities).
  describe('passwordResetCapabilities', () => {
    it('local + SMTP ready + a known origin: every capability is available, no reason', async () => {
      process.env.AUTH_MODE = 'local';
      passwordLifecycle.isOutboundEmailReady.mockResolvedValue(true);

      await expect(
        service.passwordResetCapabilities('https://lazyit.example.com'),
      ).resolves.toEqual({
        canResetLocally: true,
        canEmailResetLink: true,
        canMintTemporaryPassword: true,
      });
    });

    it('local + SMTP off: email is unavailable with smtp-not-configured, temp-password still offered', async () => {
      process.env.AUTH_MODE = 'local';
      passwordLifecycle.isOutboundEmailReady.mockResolvedValue(false);

      await expect(
        service.passwordResetCapabilities('https://lazyit.example.com'),
      ).resolves.toEqual({
        canResetLocally: true,
        canEmailResetLink: false,
        canMintTemporaryPassword: true,
        emailUnavailableReason: 'smtp-not-configured',
      });
    });

    it('local + SMTP ready but no resolvable origin: origin-unknown', async () => {
      process.env.AUTH_MODE = 'local';
      passwordLifecycle.isOutboundEmailReady.mockResolvedValue(true);

      await expect(service.passwordResetCapabilities(null)).resolves.toEqual({
        canResetLocally: true,
        canEmailResetLink: false,
        canMintTemporaryPassword: true,
        emailUnavailableReason: 'origin-unknown',
      });
    });

    it('names SMTP first when BOTH are missing — the operator should not be sent to the wrong setting', async () => {
      process.env.AUTH_MODE = 'local';
      passwordLifecycle.isOutboundEmailReady.mockResolvedValue(false);

      await expect(
        service.passwordResetCapabilities(null),
      ).resolves.toMatchObject({
        emailUnavailableReason: 'smtp-not-configured',
      });
    });

    it('OIDC: everything false and NO reason — the IdP owns resets, there is nothing to fix here', async () => {
      process.env.AUTH_MODE = 'oidc';

      await expect(
        service.passwordResetCapabilities('https://lazyit.example.com'),
      ).resolves.toEqual({
        canResetLocally: false,
        canEmailResetLink: false,
        canMintTemporaryPassword: false,
      });
      // Not even probed: SMTP readiness is irrelevant when the IdP sends the mail.
      expect(passwordLifecycle.isOutboundEmailReady).not.toHaveBeenCalled();
    });
  });

  // ADR-0058 — the manager either/or, the self/cycle guard, and the read descriptor.
  describe('manager (ADR-0058)', () => {
    const SUBJECT = '00000000-0000-0000-0000-000000000001';
    const MGR = '00000000-0000-0000-0000-000000000002';

    function liveRow(overrides: Record<string, unknown> = {}) {
      return {
        id: SUBJECT,
        email: 'a@b.com',
        firstName: 'Sub',
        lastName: 'Ject',
        role: 'VIEWER',
        externalId: null,
        managerId: null,
        managerName: null,
        deletedAt: null,
        ...overrides,
      };
    }

    it('rejects setting BOTH managerId and managerName (the XOR) before any write', async () => {
      // The zod refine normally blocks this at the edge; the service also rejects it defensively.
      // (Passed here as a raw union to exercise the resolver branch.)
      user.findFirst.mockResolvedValue(liveRow());
      await expect(
        service.update(SUBJECT, {
          manager: { managerId: MGR, managerName: 'Ana' },
        }),
      ).rejects.toBeDefined();
    });

    it('rejects a SELF-manager (managerId === subject) with 400', async () => {
      user.findFirst.mockResolvedValue(liveRow());
      await expect(
        service.update(SUBJECT, { manager: { managerId: SUBJECT } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('rejects a managerId that is not a live user with 400', async () => {
      // 1st findFirst = the subject (update's findOne); 2nd = the manager lookup → null (not live).
      user.findFirst
        .mockResolvedValueOnce(liveRow())
        .mockResolvedValueOnce(null);
      await expect(
        service.update(SUBJECT, { manager: { managerId: MGR } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a CYCLE: linking a manager whose chain reaches back to the subject (400)', async () => {
      // Subject S wants manager M; M.managerId = S → walking up from M reaches S → cycle.
      user.findFirst
        // update() findOne → the subject
        .mockResolvedValueOnce(liveRow())
        // assertManagerLinkValid: load the proposed manager M (managerId points back at S)
        .mockResolvedValueOnce({ id: MGR, managerId: SUBJECT });
      await expect(
        service.update(SUBJECT, { manager: { managerId: MGR } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('accepts a valid manager link and emits MANAGER_CHANGED { from, to }', async () => {
      user.findFirst
        // update() findOne → the subject (currently no manager)
        .mockResolvedValueOnce(liveRow())
        // assertManagerLinkValid: the proposed manager M is live, its chain ends (no further manager)
        .mockResolvedValueOnce({ id: MGR, managerId: null });
      user.update.mockResolvedValue(
        liveRow({ managerId: MGR, managerName: null }),
      );
      // serializeUser (on the update return) resolves the manager descriptor via findMany.
      user.findMany.mockResolvedValue([
        { id: MGR, firstName: 'Boss', lastName: 'Person', deletedAt: null },
      ]);

      await service.update(SUBJECT, { manager: { managerId: MGR } });

      // The manager columns are written (managerId set, managerName cleared).
      expect(user.update).toHaveBeenCalledWith({
        where: { id: SUBJECT },
        data: { managerId: MGR, managerName: null },
      });
      // A MANAGER_CHANGED row is emitted: from null → to the new manager id.
      expect(history.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: SUBJECT,
          eventType: 'MANAGER_CHANGED',
          payload: { from: null, to: MGR },
        }),
      );
    });

    it('accepts the free-text fallback (managerName) and clears managerId', async () => {
      user.findFirst.mockResolvedValueOnce(
        liveRow({ managerId: MGR, managerName: null }),
      );
      user.update.mockResolvedValue(
        liveRow({ managerId: null, managerName: 'Ana (HR)' }),
      );

      await service.update(SUBJECT, { manager: { managerName: 'Ana (HR)' } });

      expect(user.update).toHaveBeenCalledWith({
        where: { id: SUBJECT },
        data: { managerId: null, managerName: 'Ana (HR)' },
      });
      // from the prior linked id → to the external name string.
      expect(history.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'MANAGER_CHANGED',
          payload: { from: MGR, to: 'Ana (HR)' },
        }),
      );
    });

    it('resolves the READ descriptor: a LIVE linked manager (isOffboarded false)', async () => {
      user.findFirst.mockResolvedValue(liveRow({ managerId: MGR }));
      // serializeUsers loads the manager via findMany (includeSoftDeleted) — here it is LIVE.
      user.findMany.mockResolvedValue([
        {
          id: MGR,
          firstName: 'Boss',
          lastName: 'Person',
          deletedAt: null,
        },
      ]);

      const result = await service.findOneSerialized(SUBJECT);

      expect(result.manager).toEqual({
        type: 'user',
        id: MGR,
        firstName: 'Boss',
        lastName: 'Person',
        isOffboarded: false,
      });
      // The raw FK columns are never exposed on the wire.
      expect((result as Record<string, unknown>).managerId).toBeUndefined();
      expect((result as Record<string, unknown>).managerName).toBeUndefined();
    });

    it('resolves the READ descriptor: a SOFT-DELETED linked manager surfaces isOffboarded=true', async () => {
      user.findFirst.mockResolvedValue(liveRow({ managerId: MGR }));
      user.findMany.mockResolvedValue([
        {
          id: MGR,
          firstName: 'Former',
          lastName: 'Boss',
          deletedAt: new Date('2026-01-01'),
        },
      ]);

      const result = await service.findOneSerialized(SUBJECT);

      expect(result.manager).toEqual({
        type: 'user',
        id: MGR,
        firstName: 'Former',
        lastName: 'Boss',
        isOffboarded: true,
      });
    });

    it('resolves the READ descriptor: the external fallback → { type: external, name }', async () => {
      user.findFirst.mockResolvedValue(
        liveRow({ managerId: null, managerName: 'Ana (HR)' }),
      );

      const result = await service.findOneSerialized(SUBJECT);

      expect(result.manager).toEqual({ type: 'external', name: 'Ana (HR)' });
      // No manager lookup needed for the free-text fallback.
      expect(user.findMany).not.toHaveBeenCalled();
    });
  });

  // ADR-0058 §4 — clone-with-chosen-actions: new (never copied) rows, skip a soft-deleted asset, and
  // the engine toggle that FIRES vs SUPPRESSES the ACCESS_GRANTED workflow trigger.
  describe('clone (ADR-0058 §4)', () => {
    const SOURCE = '00000000-0000-0000-0000-0000000000aa';
    const NEW_ID = '00000000-0000-0000-0000-0000000000bb';
    const ADMIN = '00000000-0000-0000-0000-0000000000cc';

    function profile() {
      return { email: 'new@x.io', firstName: 'New', lastName: 'Hire' };
    }

    /** Prime the mocks so `create` (the new-user mint) returns NEW_ID (CREATED emitted on the base client). */
    function primeCreate() {
      user.create.mockResolvedValue({
        id: NEW_ID,
        ...profile(),
        role: 'VIEWER',
        externalId: null,
        managerId: null,
        managerName: null,
        deletedAt: null,
      });
      // source findOne (clone) + (no manager link to resolve on the created user)
      user.findFirst.mockResolvedValue({ id: SOURCE, deletedAt: null });
    }

    it('mints a NEW user and records clonedFrom + fireWorkflows in the CREATED payload', async () => {
      primeCreate();

      const result = await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );

      expect(result.created.id).toBe(NEW_ID);
      // The CREATED UserHistory row carries the audited provisioning choice.
      expect(history.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'CREATED',
          payload: { clonedFrom: SOURCE, fireWorkflows: false },
        }),
      );
    });

    it('opens NEW assignment rows for the new user, skipping a SOFT-DELETED asset (reported)', async () => {
      primeCreate();
      // Two selected source assignments: A1 → a LIVE asset, A2 → a soft-deleted asset (absent from
      // the live-asset findMany, so it is skipped + reported).
      const A1 = 'clxassign1aaaaaaaaaaaaaaa';
      const A2 = 'clxassign2bbbbbbbbbbbbbbb';
      prismaRef().assetAssignment.findMany.mockResolvedValue([
        { id: A1, assetId: 'asset-live' },
        { id: A2, assetId: 'asset-gone' },
      ]);
      prismaRef().asset.findMany.mockResolvedValue([{ id: 'asset-live' }]);

      const result = await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [A1, A2],
          cloneAccessGrants: [],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );

      // Exactly ONE new assignment row was opened (for the live asset), attributed to the cloning admin.
      expect(tx.assetAssignment.create).toHaveBeenCalledTimes(1);
      expect(tx.assetAssignment.create).toHaveBeenCalledWith({
        data: { assetId: 'asset-live', userId: NEW_ID, assignedById: ADMIN },
      });
      // An ASSIGNED asset-history row accompanies it.
      expect(assetHistory.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          assetId: 'asset-live',
          eventType: 'ASSIGNED',
          payload: { userId: NEW_ID },
        }),
      );
      // The soft-deleted asset's assignment is reported as skipped, never silently dropped — carrying
      // the underlying asset id so the web can resolve a friendly label (issue #361).
      expect(result.skipped).toContainEqual({
        id: A2,
        entityId: 'asset-gone',
        reason: 'asset_deleted',
      });
    });

    it('engine toggle OFF (default): writes the grant WITHOUT firing ACCESS_GRANTED (suppressed)', async () => {
      primeCreate();
      const G1 = 'clxgrant1aaaaaaaaaaaaaaaa';
      prismaRef().accessGrant.findMany.mockResolvedValue([
        {
          id: G1,
          applicationId: 'app-1',
          accessLevel: 'developer',
          expiresAt: null,
        },
      ]);

      await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [G1],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );

      // A NEW grant row is written for the new user, accessLevel copied verbatim, actor = admin.
      expect(tx.accessGrant.create).toHaveBeenCalledWith({
        data: {
          userId: NEW_ID,
          applicationId: 'app-1',
          accessLevel: 'developer',
          grantedById: ADMIN,
        },
      });
      // SUPPRESSED: no workflow plan looked up, no PENDING run written, nothing enqueued.
      expect(workflowTrigger.planForTrigger).not.toHaveBeenCalled();
      expect(tx.workflowRun.create).not.toHaveBeenCalled();
      expect(workflowTrigger.enqueue).not.toHaveBeenCalled();
      // …but the BELL still fires for the cloned grant (issue #359): the notification bell is admin
      // VISIBILITY, INDEPENDENT of the suppressed engine toggle. Same emitter a hand-created grant uses.
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledTimes(1);
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledWith({
        id: 'cloned-grant-1',
        userId: NEW_ID,
        applicationId: 'app-1',
        accessLevel: 'developer',
      });
    });

    it('opens NEW grant rows for the new user, skipping a SOFT-DELETED application (reported)', async () => {
      primeCreate();
      // Two selected source grants: G1 → a LIVE app, G2 → a soft-deleted app (absent from the live-app
      // findMany, so it is skipped + reported), mirroring the asset_deleted guard.
      const G1 = 'clxgrant1aaaaaaaaaaaaaaaa';
      const G2 = 'clxgrant2bbbbbbbbbbbbbbbb';
      prismaRef().accessGrant.findMany.mockResolvedValue([
        {
          id: G1,
          applicationId: 'app-live',
          accessLevel: 'developer',
          expiresAt: null,
        },
        {
          id: G2,
          applicationId: 'app-gone',
          accessLevel: null,
          expiresAt: null,
        },
      ]);
      // Only app-live survives the soft-delete-scoped read.
      prismaRef().application.findMany.mockResolvedValue([{ id: 'app-live' }]);

      const result = await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [G1, G2],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );

      // Exactly ONE new grant row was written (for the live app), attributed to the cloning admin.
      expect(tx.accessGrant.create).toHaveBeenCalledTimes(1);
      expect(tx.accessGrant.create).toHaveBeenCalledWith({
        data: {
          userId: NEW_ID,
          applicationId: 'app-live',
          accessLevel: 'developer',
          grantedById: ADMIN,
        },
      });
      // The soft-deleted app's grant is reported as skipped, never silently dropped — carrying the
      // underlying application id so the web can resolve a friendly label (mirrors asset_deleted, #361).
      expect(result.skipped).toContainEqual({
        id: G2,
        entityId: 'app-gone',
        reason: 'application_deleted',
      });
      // The skipped grant fired no bell (only the live grant did).
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledTimes(1);
    });

    it('engine toggle ON: fires ACCESS_GRANTED — PENDING run written in-tx, enqueued after commit', async () => {
      primeCreate();
      const G1 = 'clxgrant1aaaaaaaaaaaaaaaa';
      prismaRef().accessGrant.findMany.mockResolvedValue([
        {
          id: G1,
          applicationId: 'app-1',
          accessLevel: 'developer',
          expiresAt: null,
        },
      ]);
      // An enabled workflow exists for app-1 → a non-null plan, so the toggle ACTUALLY fires.
      workflowTrigger.planForTrigger.mockResolvedValue({
        workflowId: 'wf1',
        workflowVersionId: 5,
        applicationId: 'app-1',
        trigger: 'ACCESS_GRANTED',
        executedAsServiceAccountId: null,
        deprovisionPolicy: 'LAST_ACTIVE_GRANT',
      });

      await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [G1],
          fireWorkflowsOnClonedGrants: true,
        },
        ADMIN,
      );

      // FIRES: the plan is looked up, a PENDING run row is written INSIDE the tx, and enqueued AFTER it.
      expect(workflowTrigger.planForTrigger).toHaveBeenCalledWith(
        'ACCESS_GRANTED',
        'app-1',
      );
      expect(tx.workflowRun.create).toHaveBeenCalledTimes(1);
      expect(workflowTrigger.enqueue).toHaveBeenCalledWith('cloned-run-1');
    });

    it('404s when the source user is missing or soft-deleted', async () => {
      user.findFirst.mockResolvedValue(null);
      await expect(
        service.clone(
          SOURCE,
          {
            profile: profile(),
            cloneAssetAssignments: [],
            cloneAccessGrants: [],
            fireWorkflowsOnClonedGrants: false,
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // No user was minted.
      expect(user.create).not.toHaveBeenCalled();
    });

    // --- issue #359: the cloned grants must fire the bell, like a hand-created grant ----------------
    it('fires the bell once per cloned grant — even with the engine toggle ON (independent concerns)', async () => {
      primeCreate();
      const G1 = 'clxgrant1aaaaaaaaaaaaaaaa';
      const G2 = 'clxgrant2bbbbbbbbbbbbbbbb';
      prismaRef().accessGrant.findMany.mockResolvedValue([
        {
          id: G1,
          applicationId: 'app-1',
          accessLevel: 'admin',
          expiresAt: null,
        },
        { id: G2, applicationId: 'app-2', accessLevel: null, expiresAt: null },
      ]);

      await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [G1, G2],
          fireWorkflowsOnClonedGrants: true,
        },
        ADMIN,
      );

      // Two cloned grants → two bell emissions, each carrying the PERSISTED grant shape (the emitter
      // decides admin_granted / critical_app_access from it). The bell fires regardless of the toggle.
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledTimes(2);
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledWith({
        id: 'cloned-grant-1',
        userId: NEW_ID,
        applicationId: 'app-1',
        accessLevel: 'admin',
      });
      expect(accessGrants.emitGrantNotifications).toHaveBeenCalledWith({
        id: 'cloned-grant-1',
        userId: NEW_ID,
        applicationId: 'app-2',
        accessLevel: null,
      });
    });

    it('never fires the bell when no grants are cloned', async () => {
      primeCreate();
      await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );
      expect(accessGrants.emitGrantNotifications).not.toHaveBeenCalled();
    });

    it('a failing bell emit never breaks the clone (best-effort, post-commit)', async () => {
      primeCreate();
      const G1 = 'clxgrant1aaaaaaaaaaaaaaaa';
      prismaRef().accessGrant.findMany.mockResolvedValue([
        {
          id: G1,
          applicationId: 'app-1',
          accessLevel: 'developer',
          expiresAt: null,
        },
      ]);
      accessGrants.emitGrantNotifications.mockRejectedValue(
        new Error('bell down'),
      );

      // The clone still resolves with the created user — a notification failure is swallowed (#359).
      const result = await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [],
          cloneAccessGrants: [G1],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );
      expect(result.created.id).toBe(NEW_ID);
    });

    // --- issue #361: a duplicate-asset skip carries the underlying asset id for label resolution -----
    it('reports a duplicate-asset assignment as already_in_state, carrying the underlying entityId', async () => {
      primeCreate();
      // Two selected assignments on the SAME live asset → the second is a no-op (already_in_state).
      const A1 = 'clxassign1aaaaaaaaaaaaaaa';
      const A2 = 'clxassign2bbbbbbbbbbbbbbb';
      prismaRef().assetAssignment.findMany.mockResolvedValue([
        { id: A1, assetId: 'asset-live' },
        { id: A2, assetId: 'asset-live' },
      ]);
      prismaRef().asset.findMany.mockResolvedValue([{ id: 'asset-live' }]);

      const result = await service.clone(
        SOURCE,
        {
          profile: profile(),
          cloneAssetAssignments: [A1, A2],
          cloneAccessGrants: [],
          fireWorkflowsOnClonedGrants: false,
        },
        ADMIN,
      );

      // Exactly one new assignment row; the duplicate is reported with the asset id the web can label.
      expect(tx.assetAssignment.create).toHaveBeenCalledTimes(1);
      expect(result.skipped).toContainEqual({
        id: A2,
        entityId: 'asset-live',
        reason: 'already_in_state',
      });
    });
  });
});
