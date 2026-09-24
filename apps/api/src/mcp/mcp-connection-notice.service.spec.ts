/* eslint-disable @typescript-eslint/no-unsafe-member-access -- jest mock call arguments are typed any */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import type { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_RETENTION_MS } from '../notifications/notifications-retention.sweeper';
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
  let grantCreatedAt: Date;
  let findFirst: jest.Mock;
  let emit: jest.Mock;
  let notices: McpConnectionNoticeService;

  beforeEach(() => {
    grantCreatedAt = new Date();
    findFirst = jest.fn(() =>
      Promise.resolve({ createdAt: grantCreatedAt, userId: USER }),
    );
    emit = jest.fn().mockResolvedValue('ckn1');
    notices = new McpConnectionNoticeService(
      { oAuthGrant: { findFirst } } as unknown as PrismaService,
      { emit } as unknown as NotificationsService,
    );
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

  it('never announces a Service Account, and never a grant older than the bell’s retention', async () => {
    expect(
      await notices.announce(
        caller({
          kind: 'service',
          identity: { kind: 'service', serviceAccountId: 'sa1' },
          grant: undefined,
        }),
      ),
    ).toBe(false);
    grantCreatedAt = new Date(Date.now() - NOTIFICATION_RETENTION_MS - 1000);
    expect(await notices.announce(caller())).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: a failure never reaches the request', async () => {
    findFirst.mockRejectedValue(new Error('db down'));
    expect(() => notices.noticeFirstUse(caller())).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(emit).not.toHaveBeenCalled();
  });
});
