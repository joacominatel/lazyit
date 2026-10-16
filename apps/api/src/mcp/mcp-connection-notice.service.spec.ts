/* eslint-disable @typescript-eslint/no-unsafe-member-access -- jest mock call arguments are typed any */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { McpCaller } from './mcp-caller';
import { McpConnectionNoticeService } from './mcp-connection-notice.service';

const USER = '11111111-1111-4111-8111-111111111111';

const caller = (over: Partial<McpCaller> = {}): McpCaller => ({
  kind: 'oauth',
  identity: { kind: 'human', userId: USER, sessionEpoch: 0 },
  grant: {
    id: 'ckgrant1',
    clientId: 'lzc_1',
    clientName: 'Claude Code',
    scopes: ['lazyit.read', 'lazyit.write'],
  },
  ceiling: ['read', 'write'],
  rateKey: 'grant:ckgrant1',
  ...over,
});

describe('McpConnectionNoticeService — the first-use security notice (security §6.3, G3)', () => {
  /** Each grant row's `announcedAt`, shared by every service instance (one database, many replicas). */
  let stamps: Map<string, Date | null>;
  /** The notification rows by dedupeKey (UNIQUE), with their createdAt. */
  let rows: Map<string, Date>;
  const announcedAt = (id = 'ckgrant1') => stamps.get(id) ?? null;
  let findFirst: jest.Mock;
  let updateMany: jest.Mock;
  let sent: jest.Mock;
  let emit: jest.Mock;
  let notices: McpConnectionNoticeService;

  const replica = () =>
    new McpConnectionNoticeService(
      {
        oAuthGrant: { findFirst, updateMany },
        notification: { findUnique: sent },
      } as unknown as PrismaService,
      { emit } as unknown as NotificationsService,
    );

  beforeEach(() => {
    stamps = new Map();
    rows = new Map();
    findFirst = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve({ userId: USER, announcedAt: announcedAt(where.id) }),
    );
    // Honours the conditional `announcedAt` in the where clause, as Postgres would.
    updateMany = jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string; announcedAt: Date | null };
        data: { announcedAt: Date | null };
      }) => {
        const current = announcedAt(where.id);
        const match =
          where.announcedAt === null
            ? current === null
            : current?.getTime() === where.announcedAt.getTime();
        if (match) stamps.set(where.id, data.announcedAt);
        return Promise.resolve({ count: match ? 1 : 0 });
      },
    );
    sent = jest.fn(({ where }: { where: { dedupeKey: string } }) => {
      const createdAt = rows.get(where.dedupeKey);
      return Promise.resolve(createdAt ? { createdAt } : null);
    });
    // Honours the unique dedupeKey like NotificationsService.emit: a duplicate answers null, no row.
    emit = jest.fn(({ dedupeKey }: { dedupeKey: string }) => {
      if (rows.has(dedupeKey)) return Promise.resolve(null);
      rows.set(dedupeKey, new Date());
      return Promise.resolve('ckn1');
    });
    notices = replica();
  });

  it('emits one targeted, emailable-type notice keyed on the grant', async () => {
    expect(await notices.announce(caller())).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mcp.client_connected',
        dedupeKey: 'mcp.client_connected:ckgrant1',
        recipientUserId: USER,
        targetUserId: USER,
        severity: 'warning',
        title: 'Claude Code was connected to your lazyit account',
        metadata: {
          grantId: 'ckgrant1',
          kind: 'oauth',
          clientName: 'Claude Code',
          scopes: 'lazyit.read lazyit.write',
        },
      }),
    );
    expect(emit.mock.calls[0][0].summary).toMatch(/read and write access/);
  });

  it('is emitted once per connection per process (the DB dedupe key covers replicas and restarts)', async () => {
    await notices.announce(caller());
    await notices.announce(caller());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('remembers a grant only once its notice exists: a failed send is retried (G3 review F5)', async () => {
    // emit swallows a failure and answers null; no row exists → not stamped, not remembered.
    emit.mockResolvedValueOnce(null);
    expect(await notices.announce(caller())).toBe(true);
    expect(announcedAt()).toBeNull();
    expect(await notices.announce(caller())).toBe(true);
    expect(announcedAt()).not.toBeNull();
    expect(emit).toHaveBeenCalledTimes(2);
    // The second send succeeded: from now on the grant is remembered.
    expect(await notices.announce(caller())).toBe(false);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('treats a grant announced before announcedAt existed as announced, and records it', async () => {
    const noticeAt = new Date('2026-09-30T10:00:00.000Z');
    rows.set('mcp.client_connected:ckgrant1', noticeAt);
    expect(await notices.announce(caller())).toBe(false);
    expect(sent).toHaveBeenCalledWith({
      where: { dedupeKey: 'mcp.client_connected:ckgrant1' },
      select: { createdAt: true },
    });
    expect(emit).not.toHaveBeenCalled();
    expect(announcedAt()).toEqual(noticeAt);
    expect(await notices.announce(caller())).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('stamps announcedAt when it sends, and never announces a grant already stamped', async () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    expect(await notices.announce(caller(), now)).toBe(true);
    expect(announcedAt()).toEqual(now);
    // Another replica (or this one after a restart) reads the stamp, not the notice row.
    expect(await replica().announce(caller())).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('leaves one notice row and a stamp when two replicas see the same first use at once', async () => {
    await Promise.all([
      replica().announce(caller()),
      replica().announce(caller()),
    ]);
    expect(rows.size).toBe(1);
    expect(announcedAt()).not.toBeNull();
  });

  it('still sends on a later request when a concurrent first use observed a send that then failed', async () => {
    let failFirst!: () => void;
    emit.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          failFirst = () => resolve(null);
        }),
    );
    emit.mockResolvedValueOnce(null);
    const first = notices.announce(caller());
    await new Promise((resolve) => setImmediate(resolve));
    // A second request on the same process while the first send is in flight: it fails too.
    expect(await notices.announce(caller())).toBe(true);
    failFirst();
    expect(await first).toBe(true);
    expect(announcedAt()).toBeNull();
    // Neither failure was memoized: the next request sends and stamps.
    expect(await notices.announce(caller())).toBe(true);
    expect(rows.size).toBe(1);
    expect(announcedAt()).not.toBeNull();
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('names a personal token and says read-only / admin accurately', async () => {
    await notices.announce(
      caller({
        kind: 'personal',
        grant: {
          id: 'ckgrant2',
          clientId: null,
          clientName: 'laptop',
          scopes: ['lazyit.read'],
        },
      }),
    );
    expect(emit.mock.calls[0][0]).toMatchObject({
      title: 'Personal token "laptop" was used to connect an AI agent',
      metadata: { kind: 'personal' },
    });
    expect(emit.mock.calls[0][0].summary).toMatch(/read-only access/);
    await notices.announce(
      caller({
        grant: {
          id: 'ckgrant3',
          clientId: 'lzc_2',
          clientName: null,
          scopes: ['lazyit.read', 'lazyit.write', 'lazyit.admin'],
        },
      }),
    );
    expect(emit.mock.calls[1][0].summary).toMatch(/including admin actions/);
  });

  it('never announces a Service Account', async () => {
    expect(
      await notices.announce(
        caller({
          kind: 'service',
          identity: { kind: 'service', serviceAccountId: 'sa1' },
          grant: undefined,
        }),
      ),
    ).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('announces a grant never announced whatever its age or past use (AUD-014)', async () => {
    // The decision reads only announcedAt and the notice row, never createdAt or lastUsedAt.
    findFirst.mockImplementation(() =>
      Promise.resolve({
        userId: USER,
        announcedAt: announcedAt(),
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        lastUsedAt: new Date('2025-01-02T00:00:00.000Z'),
      }),
    );
    expect(await notices.announce(caller())).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'ckgrant1' },
      select: { userId: true, announcedAt: true },
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'mcp.client_connected:ckgrant1' }),
    );
  });

  it('is fire-and-forget: a failure never reaches the request', async () => {
    findFirst.mockRejectedValue(new Error('db down'));
    expect(() => notices.noticeFirstUse(caller())).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(emit).not.toHaveBeenCalled();
  });
});
