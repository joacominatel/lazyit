// The reconcile injects PrismaService (loads the generated Prisma client — ESM `.js` re-exports jest
// can't resolve). Stub the generated client so the real module graph loads; the DB, LDAP, users and
// history are all faked per test — this exercises the reconcile INVARIANTS without a database or a directory.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    defineExtension: (x: unknown) => x,
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      constructor(message: string, opts: { code: string }) {
        super(message);
        this.code = opts.code;
      }
    },
  },
  // UsersService (transitively imported) dereferences Role.VIEWER as a VALUE — expose it or create() throws.
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. The reconcile only uses the fake UsersService below, so a bare stub is enough.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { Logger } from '@nestjs/common';
import { DirectoryReconcileService } from './directory-reconcile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DirectoryConnectionService } from './directory-connection.service';
import type {
  DirectoryEntry,
  DirectoryLdapClient,
} from './directory-ldap.client';
import type { UsersService } from '../users/users.service';
import type { UserHistoryService } from '../user-history/user-history.service';

/**
 * The keys the reconcile may NEVER write onto a matched/reactivated person (mass-assignment / escalation /
 * credentials). `sessionEpoch` and `mcpCredentialEpoch` are deliberately listed: the sync's ONE sanctioned
 * epoch write is the revoking bump of both on an active→offboarded transition (#1308, ADR-0086 §8; ADR-0097
 * decision 8 as amended), so the offboard assertions use {@link FORBIDDEN_OFFBOARD_KEYS} and check the bumps
 * explicitly instead.
 */
const FORBIDDEN_WRITE_KEYS = [
  'role',
  'externalId',
  'passwordHash',
  'directoryOnly',
  'sessionEpoch',
  'mcpCredentialEpoch',
  'mustChangePassword',
];
/** The offboard path's guard: everything above except the two epochs, which it may only ever increment. */
const FORBIDDEN_OFFBOARD_KEYS = FORBIDDEN_WRITE_KEYS.filter(
  (key) => key !== 'sessionEpoch' && key !== 'mcpCredentialEpoch',
);

interface LocalPerson {
  id: string;
  directorySourceId: string | null;
  isActive: boolean;
  role?: string;
  directoryOffboardedAt: Date | null;
  directoryReenabledAt?: Date | null;
  firstName: string;
  lastName: string;
  directoryAttrs: unknown;
}

/** Typed views of the recorded mock-call arguments, so reads are lint-safe (no `any` member access). */
type CreateDto = { email: string; firstName: string; lastName: string };
type CreateOpts = {
  directoryOnly?: boolean;
  directorySource?: string;
  directorySourceId?: string;
  directoryAttrs?: Record<string, unknown>;
};
type HistoryEvent = {
  eventType: string;
  payload: { action?: string; reason?: string; fields?: string[] };
  actor: Record<string, unknown>;
};
type UpdateArg = { data: Record<string, unknown> };
type UpdateManyArg = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

/** Read the i-th recorded call of a jest mock as a typed argument tuple (keeps reads lint-safe). */
function nthCall<T extends unknown[]>(mock: jest.Mock, i: number): T {
  return mock.mock.calls[i] as T;
}

function makeEntry(
  guid: string,
  attrs: Record<string, string>,
  memberOf: string[] = [],
): DirectoryEntry {
  return { objectGUID: guid, attributes: attrs, memberOf };
}

/**
 * Wire a reconcile service over fakes: a resolved config (or null when `disabled`) + attribute map, an LDAP
 * client returning `entries`, a `user.findMany` returning the local 'ad' cohort, and captured `update` /
 * `$transaction` / `users.create` / `history.record` doubles. Returns the handles the tests assert against.
 */
function makeService(opts: {
  entries: DirectoryEntry[];
  localPeople: LocalPerson[];
  graceDays?: number;
  serviceAccountId?: string | null;
  emailTaken?: boolean;
  disabled?: boolean;
  resolveThrows?: boolean;
  attributeMap?: Record<string, string>;
  /** The UsersService last-admin predicate's answer (default: another active ADMIN exists). */
  anotherActiveAdmin?: boolean;
  /** Rows the conditional offboard / reactivation write matches (0 = an admin edit landed mid-sweep). */
  conditionalWriteCount?: number;
}) {
  const attributeMap = opts.attributeMap ?? {
    firstName: 'givenName',
    lastName: 'sn',
    email: 'mail',
  };
  const userUpdate = jest.fn().mockResolvedValue({});
  const txUserUpdate = jest.fn().mockResolvedValue({});
  const txUserUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: opts.conditionalWriteCount ?? 1 });
  const userFindMany = jest.fn().mockResolvedValue(opts.localPeople);
  const userFindFirst = jest
    .fn()
    .mockResolvedValue(opts.emailTaken ? { id: 'existing-login-user' } : null);
  const $transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ user: { update: txUserUpdate, updateMany: txUserUpdateMany } }),
  );
  const prisma = {
    user: {
      findMany: userFindMany,
      findFirst: userFindFirst,
      update: userUpdate,
    },
    $transaction,
  } as unknown as PrismaService;

  const recordRun = jest.fn().mockResolvedValue(undefined);
  const resolveConfig = opts.resolveThrows
    ? jest
        .fn()
        .mockRejectedValue(new Error('bind password decrypt failed: s3cr3t'))
    : jest.fn().mockResolvedValue(
        opts.disabled
          ? null
          : {
              host: 'dc',
              port: 636,
              transport: 'ldaps',
              rejectUnauthorized: true,
              baseDN: 'DC=corp,DC=com',
              bindDN: 'CN=svc,DC=corp,DC=com',
              bindPassword: 'secret',
              searchFilter: '(objectClass=user)',
              attributeNames: Object.values(attributeMap),
            },
      );
  const config = {
    resolveConfig,
    getAttributeMap: jest.fn().mockResolvedValue(attributeMap),
    getOffboardGraceDays: jest.fn().mockResolvedValue(opts.graceDays ?? 7),
    getServiceAccountId: jest
      .fn()
      .mockResolvedValue(opts.serviceAccountId ?? null),
    recordRun,
  } as unknown as DirectoryConnectionService;

  const fetchEntries = jest.fn().mockResolvedValue(opts.entries);
  const ldap = { fetchEntries } as unknown as DirectoryLdapClient;

  const usersCreate = jest.fn().mockResolvedValue({ id: 'new-person' });
  const hasAnotherActiveAdmin = jest
    .fn()
    .mockResolvedValue(opts.anotherActiveAdmin ?? true);
  const users = {
    create: usersCreate,
    hasAnotherActiveAdmin,
  } as unknown as UsersService;

  const historyRecord = jest.fn().mockResolvedValue({});
  const history = { record: historyRecord } as unknown as UserHistoryService;

  const service = new DirectoryReconcileService(
    prisma,
    config,
    ldap,
    users,
    history,
  );
  return {
    service,
    fetchEntries,
    userFindMany,
    userUpdate,
    txUserUpdate,
    txUserUpdateMany,
    usersCreate,
    hasAnotherActiveAdmin,
    historyRecord,
    recordRun,
  };
}

/** Assert an update `data` object never carries a forbidden (escalation / credential / login) key. */
function assertNoForbiddenKeys(
  data: Record<string, unknown>,
  keys: string[] = FORBIDDEN_WRITE_KEYS,
): void {
  for (const key of keys) {
    expect(Object.prototype.hasOwnProperty.call(data, key)).toBe(false);
  }
}

describe('DirectoryReconcileService.reconcile (ADR-0091 hard invariants)', () => {
  it('NEW entry → creates a directoryOnly person via the sanctioned rail (no role/externalId/password)', async () => {
    const { service, usersCreate } = makeService({
      localPeople: [],
      entries: [
        makeEntry('G1', {
          givenName: 'Ada',
          sn: 'Lovelace',
          mail: 'ada@corp.com',
        }),
      ],
    });
    const result = await service.reconcile();
    expect(result.ok).toBe(true);
    expect(result.counts.created).toBe(1);
    expect(usersCreate).toHaveBeenCalledTimes(1);
    const [dto, actorId, createOpts] = nthCall<
      [CreateDto, string | undefined, CreateOpts]
    >(usersCreate, 0);
    // The create dto carries ONLY profile identity — never role/externalId/password (VIEWER is forced by the rail).
    expect(Object.keys(dto).sort()).toEqual(['email', 'firstName', 'lastName']);
    expect(dto.email).toBe('ada@corp.com');
    expect(actorId).toBeUndefined(); // system actor — the rail can't thread a service-account actor
    expect(createOpts.directoryOnly).toBe(true);
    expect(createOpts.directorySource).toBe('ad');
    expect(createOpts.directorySourceId).toBe('G1');
  });

  it('MATCHED entry → refreshes profile/attrs but NEVER touches role/externalId/passwordHash/directoryOnly', async () => {
    const { service, txUserUpdate, historyRecord } = makeService({
      localPeople: [
        {
          id: 'u1',
          directorySourceId: 'G1',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Old',
          lastName: 'Name',
          directoryAttrs: { lastSeenAt: '2020-01-01T00:00:00.000Z' },
        },
      ],
      entries: [
        makeEntry('G1', { givenName: 'New', sn: 'Name', mail: 'x@corp.com' }),
      ],
    });
    const result = await service.reconcile();
    expect(result.counts.updated).toBe(1);
    expect(txUserUpdate).toHaveBeenCalledTimes(1);
    const { data } = nthCall<[UpdateArg]>(txUserUpdate, 0)[0];
    expect(data.firstName).toBe('New');
    assertNoForbiddenKeys(data);
    // A meaningful change appends a UserHistory row with a directorySync payload.
    expect(historyRecord).toHaveBeenCalledTimes(1);
    const event = nthCall<[unknown, HistoryEvent]>(historyRecord, 0)[1];
    expect(event.eventType).toBe('UPDATED');
    expect(event.payload.action).toBe('directorySync');
  });

  it('attributes UserHistory to the configured service account (ADR-0048)', async () => {
    const { service, historyRecord } = makeService({
      serviceAccountId: 'sa_directory',
      localPeople: [
        {
          id: 'u1',
          directorySourceId: 'G1',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Old',
          lastName: 'Name',
          directoryAttrs: { lastSeenAt: '2020-01-01T00:00:00.000Z' },
        },
      ],
      entries: [makeEntry('G1', { givenName: 'New', sn: 'Name' })],
    });
    await service.reconcile();
    const event = nthCall<[unknown, HistoryEvent]>(historyRecord, 0)[1];
    expect(event.actor).toEqual({ serviceAccountId: 'sa_directory' });
  });

  it('UNCHANGED entry → idempotent: bumps lastSeenAt silently, no history, counted as skipped', async () => {
    const { service, userUpdate, txUserUpdate, historyRecord } = makeService({
      localPeople: [
        {
          id: 'u1',
          directorySourceId: 'G1',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Ada',
          lastName: 'Lovelace',
          directoryAttrs: {
            mail: 'ada@corp.com',
            lastSeenAt: '2020-01-01T00:00:00.000Z',
          },
        },
      ],
      entries: [
        makeEntry('G1', {
          givenName: 'Ada',
          sn: 'Lovelace',
          mail: 'ada@corp.com',
        }),
      ],
    });
    const result = await service.reconcile();
    expect(result.counts.updated).toBe(0);
    expect(result.counts.skipped).toBe(1);
    // The silent heartbeat bump goes through the plain (non-tx) update; no history, no tx update.
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(historyRecord).not.toHaveBeenCalled();
  });

  it('DISAPPEARED past grace → SOFT offboard (isActive=false + directoryOffboardedAt), never hard-delete', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { service, txUserUpdateMany, historyRecord } = makeService({
      graceDays: 7,
      localPeople: [
        {
          id: 'u2',
          directorySourceId: 'G2',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Gone',
          lastName: 'Person',
          directoryAttrs: { lastSeenAt: stale },
        },
      ],
      entries: [], // G2 absent from AD
    });
    const result = await service.reconcile();
    expect(result.counts.offboarded).toBe(1);
    const { where, data } = nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0];
    // Only a row still active, unstamped and not re-enabled by hand is written: an admin edit mid-sweep wins.
    expect(where).toEqual({
      id: 'u2',
      isActive: true,
      directoryOffboardedAt: null,
      directoryReenabledAt: null,
      deletedAt: null,
    });
    expect(data.isActive).toBe(false);
    expect(data.directoryOffboardedAt).toBeInstanceOf(Date);
    assertNoForbiddenKeys(data, FORBIDDEN_OFFBOARD_KEYS);
    const event = nthCall<[unknown, HistoryEvent]>(historyRecord, 0)[1];
    expect(event.payload.reason).toBe('offboarded');
  });

  it('offboarding an ACTIVE person revokes their local sessions and MCP credentials (both epochs +1)', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { service, txUserUpdateMany } = makeService({
      graceDays: 7,
      localPeople: [
        {
          id: 'u2',
          directorySourceId: 'G2',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Gone',
          lastName: 'Person',
          directoryAttrs: { lastSeenAt: stale },
        },
      ],
      entries: [],
    });
    await service.reconcile();
    expect(txUserUpdateMany).toHaveBeenCalledTimes(1);
    const { data } = nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0];
    expect(data.sessionEpoch).toEqual({ increment: 1 });
    expect(data.mcpCredentialEpoch).toEqual({ increment: 1 });
  });

  it('an admin edit lands mid-sweep (the conditional offboard matches 0 rows) → no history, counted as skipped', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { service, txUserUpdate, txUserUpdateMany, historyRecord } =
      makeService({
        graceDays: 7,
        localPeople: [
          {
            id: 'u2',
            directorySourceId: 'G2',
            isActive: true,
            directoryOffboardedAt: null,
            firstName: 'Gone',
            lastName: 'Person',
            directoryAttrs: { lastSeenAt: stale },
          },
        ],
        entries: [],
        conditionalWriteCount: 0,
      });
    const result = await service.reconcile();
    expect(result.counts.offboarded).toBe(0);
    expect(result.counts.skipped).toBe(1);
    // The epoch bump rides the same conditional write, so a 0-row match bumps nothing.
    expect(txUserUpdateMany).toHaveBeenCalledTimes(1);
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(historyRecord).not.toHaveBeenCalled();
  });

  describe('a manual deactivation is never auto-reactivated (#1311)', () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const manuallyDeactivated: LocalPerson = {
      id: 'u4',
      directorySourceId: 'G4',
      isActive: false,
      directoryOffboardedAt: null,
      firstName: 'Manually',
      lastName: 'Deactivated',
      directoryAttrs: { lastSeenAt: stale },
    };

    it('absent past grace → not offboarded: nothing written, counted as skipped', async () => {
      const {
        service,
        userUpdate,
        txUserUpdate,
        txUserUpdateMany,
        historyRecord,
      } = makeService({
        graceDays: 7,
        localPeople: [manuallyDeactivated],
        entries: [],
      });
      const result = await service.reconcile();
      expect(result.counts.offboarded).toBe(0);
      expect(result.counts.skipped).toBe(1);
      expect(userUpdate).not.toHaveBeenCalled();
      expect(txUserUpdate).not.toHaveBeenCalled();
      expect(txUserUpdateMany).not.toHaveBeenCalled();
      expect(historyRecord).not.toHaveBeenCalled();
    });

    it('reappears → stays inactive (the refresh never writes isActive or the offboard stamp)', async () => {
      const { service, userUpdate, txUserUpdate } = makeService({
        localPeople: [manuallyDeactivated],
        entries: [
          makeEntry('G4', { givenName: 'Manually', sn: 'Deactivated' }),
        ],
      });
      const result = await service.reconcile();
      expect(result.counts.updated).toBe(0);
      expect(txUserUpdate).not.toHaveBeenCalled();
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data).not.toHaveProperty('isActive');
      expect(data).not.toHaveProperty('directoryOffboardedAt');
    });

    it('inactive for both reasons — deactivated by hand, then gone from AD past grace — stays inactive when AD lists them again', async () => {
      const {
        service,
        fetchEntries,
        userUpdate,
        txUserUpdate,
        txUserUpdateMany,
      } = makeService({
        graceDays: 7,
        localPeople: [manuallyDeactivated],
        entries: [],
      });

      const gone = await service.reconcile();
      expect(gone.counts.offboarded).toBe(0);
      expect(txUserUpdateMany).not.toHaveBeenCalled();

      fetchEntries.mockResolvedValueOnce([
        makeEntry('G4', { givenName: 'Manually', sn: 'Deactivated' }),
      ]);
      const back = await service.reconcile();
      expect(back.counts.updated).toBe(0);
      expect(txUserUpdate).not.toHaveBeenCalled();
      expect(txUserUpdateMany).not.toHaveBeenCalled();
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data).not.toHaveProperty('isActive');
    });
  });

  describe('a manual re-enable sticks while the person stays absent (#1522)', () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const reenabledAt = new Date('2026-10-01T00:00:00.000Z');
    const reenabledAfterSyncOffboard: LocalPerson = {
      id: 'u5',
      directorySourceId: 'G5',
      isActive: true,
      directoryOffboardedAt: new Date('2026-09-01T00:00:00.000Z'),
      directoryReenabledAt: reenabledAt,
      firstName: 'Sync',
      lastName: 'Offboarded',
      directoryAttrs: { lastSeenAt: stale },
    };
    const reenabledAfterManualDeactivation: LocalPerson = {
      id: 'u6',
      directorySourceId: 'G6',
      isActive: true,
      directoryOffboardedAt: null,
      directoryReenabledAt: reenabledAt,
      firstName: 'Hand',
      lastName: 'Deactivated',
      directoryAttrs: { lastSeenAt: stale },
    };

    it.each([
      ['offboarded by the sync', reenabledAfterSyncOffboard],
      ['deactivated by hand', reenabledAfterManualDeactivation],
    ])(
      're-enabled after being %s, still absent past grace → stays active: nothing written',
      async (_history, person) => {
        const {
          service,
          userUpdate,
          txUserUpdate,
          txUserUpdateMany,
          historyRecord,
        } = makeService({ graceDays: 7, localPeople: [person], entries: [] });
        const result = await service.reconcile();
        expect(result.counts.offboarded).toBe(0);
        expect(userUpdate).not.toHaveBeenCalled();
        expect(txUserUpdate).not.toHaveBeenCalled();
        expect(txUserUpdateMany).not.toHaveBeenCalled();
        expect(historyRecord).not.toHaveBeenCalled();
      },
    );

    it('a sync-offboarded person re-enabled before the mark existed still stays active (the stamp holds)', async () => {
      const { service, txUserUpdateMany } = makeService({
        graceDays: 7,
        localPeople: [
          { ...reenabledAfterSyncOffboard, directoryReenabledAt: null },
        ],
        entries: [],
      });
      const result = await service.reconcile();
      expect(result.counts.offboarded).toBe(0);
      expect(txUserUpdateMany).not.toHaveBeenCalled();
    });

    it('reappears → the refresh clears the mark silently (no history, no reactivation write)', async () => {
      const { service, userUpdate, txUserUpdate, historyRecord } = makeService({
        localPeople: [reenabledAfterManualDeactivation],
        entries: [makeEntry('G6', { givenName: 'Hand', sn: 'Deactivated' })],
      });
      const result = await service.reconcile();
      expect(result.counts.updated).toBe(0);
      expect(result.counts.skipped).toBe(1);
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data.directoryReenabledAt).toBeNull();
      expect(data).not.toHaveProperty('isActive');
      expect(txUserUpdate).not.toHaveBeenCalled();
      expect(historyRecord).not.toHaveBeenCalled();
    });

    it('re-enabled after a sync offboard, then reappears → the refresh clears both the mark and the stamp, so a later absence past grace offboards them', async () => {
      const {
        service,
        fetchEntries,
        userFindMany,
        userUpdate,
        txUserUpdateMany,
        historyRecord,
      } = makeService({
        graceDays: 7,
        localPeople: [reenabledAfterSyncOffboard],
        entries: [makeEntry('G5', { givenName: 'Sync', sn: 'Offboarded' })],
      });

      const back = await service.reconcile();
      expect(back.counts.updated).toBe(0);
      expect(txUserUpdateMany).not.toHaveBeenCalled();
      expect(historyRecord).not.toHaveBeenCalled();
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data.directoryReenabledAt).toBeNull();
      expect(data.directoryOffboardedAt).toBeNull();
      expect(data).not.toHaveProperty('isActive');

      // The next load sees what that refresh wrote; then they leave AD for good.
      userFindMany.mockResolvedValueOnce([
        {
          ...reenabledAfterSyncOffboard,
          directoryOffboardedAt: null,
          directoryReenabledAt: null,
        },
      ]);
      fetchEntries.mockResolvedValueOnce([]);
      const gone = await service.reconcile();
      expect(gone.counts.offboarded).toBe(1);
      expect(txUserUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('a legacy stamp-only row (re-enabled before the mark existed) heals on reappearance: the stamp is cleared', async () => {
      const { service, userUpdate, txUserUpdateMany } = makeService({
        localPeople: [
          { ...reenabledAfterSyncOffboard, directoryReenabledAt: null },
        ],
        entries: [makeEntry('G5', { givenName: 'Sync', sn: 'Offboarded' })],
      });
      await service.reconcile();
      expect(txUserUpdateMany).not.toHaveBeenCalled();
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data.directoryOffboardedAt).toBeNull();
      expect(data).not.toHaveProperty('directoryReenabledAt');
    });

    it('a matched person who was never re-enabled by hand → the refresh does not write the mark', async () => {
      const { service, userUpdate } = makeService({
        localPeople: [
          { ...reenabledAfterManualDeactivation, directoryReenabledAt: null },
        ],
        entries: [makeEntry('G6', { givenName: 'Hand', sn: 'Deactivated' })],
      });
      await service.reconcile();
      const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
      expect(data).not.toHaveProperty('directoryReenabledAt');
    });

    it('a deactivate-then-re-enable landing mid-sweep wins: the offboard requires no mark, matches 0 rows, writes nothing', async () => {
      const { service, txUserUpdateMany, historyRecord } = makeService({
        graceDays: 7,
        // The snapshot predates the admin's edits: active, unstamped, unmarked.
        localPeople: [
          { ...reenabledAfterManualDeactivation, directoryReenabledAt: null },
        ],
        entries: [],
        conditionalWriteCount: 0,
      });
      const result = await service.reconcile();
      const { where } = nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0];
      expect(where.directoryReenabledAt).toBeNull();
      expect(result.counts.offboarded).toBe(0);
      expect(result.counts.skipped).toBe(1);
      expect(historyRecord).not.toHaveBeenCalled();
    });
  });

  // SEC-021: the offboard sweep must never deactivate the last active ADMIN — that locks the instance with
  // nobody able to sign in and administer it. The person is skipped (nothing written), a warning is logged,
  // and the rest of the sweep carries on.
  describe('last-admin protection on offboard (SEC-021)', () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const goneAdmin: LocalPerson = {
      id: 'u-admin',
      directorySourceId: 'GA',
      isActive: true,
      role: 'ADMIN',
      directoryOffboardedAt: null,
      firstName: 'Last',
      lastName: 'Admin',
      directoryAttrs: { lastSeenAt: stale },
    };
    const goneMember: LocalPerson = {
      id: 'u-member',
      directorySourceId: 'GM',
      isActive: true,
      role: 'MEMBER',
      directoryOffboardedAt: null,
      firstName: 'Gone',
      lastName: 'Member',
      directoryAttrs: { lastSeenAt: stale },
    };

    afterEach(() => jest.restoreAllMocks());

    it('skips the LAST active ADMIN, warns, and still offboards everyone else', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const {
        service,
        txUserUpdateMany,
        historyRecord,
        hasAnotherActiveAdmin,
      } = makeService({
        graceDays: 7,
        localPeople: [goneAdmin, goneMember],
        entries: [],
        anotherActiveAdmin: false,
      });

      const result = await service.reconcile();

      expect(result.ok).toBe(true);
      expect(hasAnotherActiveAdmin).toHaveBeenCalledWith('u-admin');
      expect(result.counts.offboarded).toBe(1);
      expect(result.counts.skipped).toBe(1);
      // Only the member is written; the admin row is untouched (no isActive flip, no history).
      expect(txUserUpdateMany).toHaveBeenCalledTimes(1);
      expect(nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0].where.id).toBe(
        'u-member',
      );
      expect(historyRecord).toHaveBeenCalledTimes(1);
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(
        warned.some(
          (m) => m.includes('last-active-admin') && m.includes('u-admin'),
        ),
      ).toBe(true);
      // The warning carries the id only — never the person's name (logs stay PII-free).
      expect(
        warned.some((m) => m.includes('Last') || m.includes('Admin ')),
      ).toBe(false);
    });

    it('offboards an ADMIN normally when another active ADMIN remains', async () => {
      const { service, txUserUpdateMany } = makeService({
        graceDays: 7,
        localPeople: [goneAdmin],
        entries: [],
        anotherActiveAdmin: true,
      });

      const result = await service.reconcile();

      expect(result.counts.offboarded).toBe(1);
      const { data } = nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0];
      expect(data.isActive).toBe(false);
    });

    it('never consults the predicate for a non-admin or an already-inactive admin', async () => {
      const { service, hasAnotherActiveAdmin } = makeService({
        graceDays: 7,
        localPeople: [goneMember, { ...goneAdmin, isActive: false }],
        entries: [],
        anotherActiveAdmin: false,
      });

      const result = await service.reconcile();

      expect(result.counts.offboarded).toBe(1);
      expect(result.counts.skipped).toBe(1);
      expect(hasAnotherActiveAdmin).not.toHaveBeenCalled();
    });
  });

  it('an already-offboarded person still absent → no write at all (repeated runs never bump again)', async () => {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const {
      service,
      userUpdate,
      txUserUpdate,
      txUserUpdateMany,
      historyRecord,
    } = makeService({
      graceDays: 7,
      localPeople: [
        {
          id: 'u2',
          directorySourceId: 'G2',
          isActive: false,
          directoryOffboardedAt: new Date(stale),
          firstName: 'Gone',
          lastName: 'Person',
          directoryAttrs: { lastSeenAt: stale },
        },
      ],
      entries: [],
    });
    const result = await service.reconcile();
    expect(result.counts.offboarded).toBe(0);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(txUserUpdateMany).not.toHaveBeenCalled();
    expect(historyRecord).not.toHaveBeenCalled();
  });

  const syncOffboarded: LocalPerson = {
    id: 'u2',
    directorySourceId: 'G2',
    isActive: false,
    directoryOffboardedAt: new Date('2020-01-01T00:00:00.000Z'),
    firstName: 'Back',
    lastName: 'Again',
    directoryAttrs: { lastSeenAt: '2020-01-01T00:00:00.000Z' },
  };

  it('REAPPEARED after our offboard → reactivates WITHOUT touching sessionEpoch (the person signs in again)', async () => {
    const { service, txUserUpdate, txUserUpdateMany, historyRecord } =
      makeService({
        localPeople: [syncOffboarded],
        entries: [makeEntry('G2', { givenName: 'Back', sn: 'Again' })],
      });
    const result = await service.reconcile();
    expect(result.counts.updated).toBe(1);
    const { where, data } = nthCall<[UpdateManyArg]>(txUserUpdateMany, 0)[0];
    // Only a row still carrying our stamp is reactivated: an admin edit mid-sweep wins.
    expect(where).toEqual({
      id: 'u2',
      isActive: false,
      directoryOffboardedAt: { not: null },
      deletedAt: null,
    });
    expect(data).toEqual({ isActive: true, directoryOffboardedAt: null });
    assertNoForbiddenKeys(nthCall<[UpdateArg]>(txUserUpdate, 0)[0].data);
    const event = nthCall<[unknown, HistoryEvent]>(historyRecord, 0)[1];
    expect(event.payload.fields).toContain('reactivated');
  });

  it('an admin edit lands mid-sweep (the conditional reactivation matches 0 rows) → stays as the admin left it, no history', async () => {
    const { service, txUserUpdate, historyRecord } = makeService({
      localPeople: [syncOffboarded],
      entries: [makeEntry('G2', { givenName: 'Back', sn: 'Again' })],
      conditionalWriteCount: 0,
    });
    const result = await service.reconcile();
    expect(result.counts.updated).toBe(0);
    expect(result.counts.skipped).toBe(1);
    const { data } = nthCall<[UpdateArg]>(txUserUpdate, 0)[0];
    expect(data).not.toHaveProperty('isActive');
    expect(data).not.toHaveProperty('directoryOffboardedAt');
    assertNoForbiddenKeys(data);
    expect(historyRecord).not.toHaveBeenCalled();
  });

  it('DISAPPEARED within grace → NOT offboarded (a single dropped run cannot mass-deactivate)', async () => {
    const recent = new Date().toISOString();
    const { service, txUserUpdateMany } = makeService({
      graceDays: 7,
      localPeople: [
        {
          id: 'u3',
          directorySourceId: 'G3',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Recently',
          lastName: 'Missing',
          directoryAttrs: { lastSeenAt: recent },
        },
      ],
      entries: [],
    });
    const result = await service.reconcile();
    expect(result.counts.offboarded).toBe(0);
    expect(result.counts.skipped).toBe(1);
    expect(txUserUpdateMany).not.toHaveBeenCalled();
  });

  it('email collision with a live user → placeholder email + emailConflict flag (never auto-merge)', async () => {
    const { service, usersCreate } = makeService({
      localPeople: [],
      emailTaken: true,
      entries: [
        makeEntry('G9', {
          givenName: 'Dup',
          sn: 'Mail',
          mail: 'taken@corp.com',
        }),
      ],
    });
    const result = await service.reconcile();
    expect(result.counts.created).toBe(1);
    const [dto, , createOpts] = nthCall<
      [CreateDto, string | undefined, CreateOpts]
    >(usersCreate, 0);
    expect(dto.email).toBe('G9@directory.local');
    expect(createOpts.directoryAttrs?.emailConflict).toBe(true);
  });

  it('re-run is idempotent — a second identical pass creates nothing new (all skipped)', async () => {
    const person: LocalPerson = {
      id: 'u1',
      directorySourceId: 'G1',
      isActive: true,
      directoryOffboardedAt: null,
      firstName: 'Ada',
      lastName: 'Lovelace',
      directoryAttrs: {
        mail: 'ada@corp.com',
        lastSeenAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const { service, usersCreate } = makeService({
      localPeople: [person],
      entries: [
        makeEntry('G1', {
          givenName: 'Ada',
          sn: 'Lovelace',
          mail: 'ada@corp.com',
        }),
      ],
    });
    const result = await service.reconcile();
    expect(usersCreate).not.toHaveBeenCalled();
    expect(result.counts.created).toBe(0);
    expect(result.counts.skipped).toBe(1);
  });

  it('config-resolution throw (key rotation / decrypt fail) → ok:false + recorded error, never a raw throw or leak', async () => {
    const { service, recordRun } = makeService({
      localPeople: [],
      entries: [],
      resolveThrows: true,
    });
    const result = await service.reconcile();
    // The "always HTTP 200, inspect ok" contract holds even when config resolution throws.
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('s3cr3t'); // scrubbed: name only, never the secret
    expect(recordRun).toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.any(Date),
    );
  });

  it('MATCHED conflicted person → carries emailConflict forward (no phantom update/history row)', async () => {
    const { service, userUpdate, txUserUpdate, historyRecord } = makeService({
      localPeople: [
        {
          id: 'u1',
          directorySourceId: 'G1',
          isActive: true,
          directoryOffboardedAt: null,
          firstName: 'Dup',
          lastName: 'Mail',
          directoryAttrs: {
            mail: 'taken@corp.com',
            emailConflict: true,
            lastSeenAt: '2020-01-01T00:00:00.000Z',
          },
        },
      ],
      entries: [
        makeEntry('G1', {
          givenName: 'Dup',
          sn: 'Mail',
          mail: 'taken@corp.com',
        }),
      ],
    });
    const result = await service.reconcile();
    // Nothing meaningful changed → silent heartbeat only, no phantom UPDATED count or history row.
    expect(result.counts.updated).toBe(0);
    expect(result.counts.skipped).toBe(1);
    expect(txUserUpdate).not.toHaveBeenCalled();
    expect(historyRecord).not.toHaveBeenCalled();
    // …and the flag survives the refresh instead of being wiped.
    const { data } = nthCall<[UpdateArg]>(userUpdate, 0)[0];
    const attrs = data.directoryAttrs as Record<string, unknown>;
    expect(attrs.emailConflict).toBe(true);
  });

  it('disabled/unconfigured → no-op result, no LDAP bind', async () => {
    const { service, recordRun } = makeService({
      localPeople: [],
      entries: [],
      disabled: true,
    });
    const result = await service.reconcile();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled or not fully configured/);
    expect(recordRun).not.toHaveBeenCalled();
  });
});
