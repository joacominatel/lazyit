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

import { DirectoryReconcileService } from './directory-reconcile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DirectoryConnectionService } from './directory-connection.service';
import type {
  DirectoryEntry,
  DirectoryLdapClient,
} from './directory-ldap.client';
import type { UsersService } from '../users/users.service';
import type { UserHistoryService } from '../user-history/user-history.service';

/** The keys the reconcile may NEVER write onto a matched/offboarded person (mass-assignment / escalation). */
const FORBIDDEN_WRITE_KEYS = [
  'role',
  'externalId',
  'passwordHash',
  'directoryOnly',
  'sessionEpoch',
  'mustChangePassword',
];

interface LocalPerson {
  id: string;
  directorySourceId: string | null;
  isActive: boolean;
  directoryOffboardedAt: Date | null;
  firstName: string;
  lastName: string;
  directoryAttrs: unknown;
}

/** Typed views of the recorded mock-call arguments, so reads are lint-safe (no `any` member access). */
type CreateDto = { email: string; firstName: string; lastName: string };
type CreateOpts = {
  skipIdpWriteBack?: boolean;
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
}) {
  const attributeMap = opts.attributeMap ?? {
    firstName: 'givenName',
    lastName: 'sn',
    email: 'mail',
  };
  const userUpdate = jest.fn().mockResolvedValue({});
  const txUserUpdate = jest.fn().mockResolvedValue({});
  const userFindMany = jest.fn().mockResolvedValue(opts.localPeople);
  const userFindFirst = jest
    .fn()
    .mockResolvedValue(opts.emailTaken ? { id: 'existing-login-user' } : null);
  const $transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ user: { update: txUserUpdate } }),
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
  const users = { create: usersCreate } as unknown as UsersService;

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
    userUpdate,
    txUserUpdate,
    usersCreate,
    historyRecord,
    recordRun,
  };
}

/** Assert an update `data` object never carries a forbidden (escalation / credential / login) key. */
function assertNoForbiddenKeys(data: Record<string, unknown>): void {
  for (const key of FORBIDDEN_WRITE_KEYS) {
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
    expect(createOpts.skipIdpWriteBack).toBe(true);
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
    const { service, txUserUpdate, historyRecord } = makeService({
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
    const { data } = nthCall<[UpdateArg]>(txUserUpdate, 0)[0];
    expect(data.isActive).toBe(false);
    expect(data.directoryOffboardedAt).toBeInstanceOf(Date);
    assertNoForbiddenKeys(data);
    const event = nthCall<[unknown, HistoryEvent]>(historyRecord, 0)[1];
    expect(event.payload.reason).toBe('offboarded');
  });

  it('DISAPPEARED within grace → NOT offboarded (a single dropped run cannot mass-deactivate)', async () => {
    const recent = new Date().toISOString();
    const { service, txUserUpdate } = makeService({
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
    expect(txUserUpdate).not.toHaveBeenCalled();
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
