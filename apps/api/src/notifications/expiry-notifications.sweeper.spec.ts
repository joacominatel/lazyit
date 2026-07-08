import { Test } from '@nestjs/testing';
import { isEmailableNotificationType } from '../smtp/email.constants';
import { ExpiryNotificationsSweeper } from './expiry-notifications.sweeper';
import {
  NotificationsService,
  type EmitNotificationInput,
} from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB) — same as the
// access-grants sweeper spec. The sweeper only uses Prisma via the injected mock below.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

const DAY = 24 * 60 * 60 * 1000;

type Asset = {
  id: string;
  name: string;
  assetTag: string | null;
  warrantyEnd: Date | null;
  deletedAt: Date | null;
};

type Grant = {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  application: { id: string; name: string };
  user: { firstName: string; lastName: string };
};

describe('ExpiryNotificationsSweeper', () => {
  let sweeper: ExpiryNotificationsSweeper;
  let emit: jest.Mock<Promise<string | null>, [EmitNotificationInput]>;
  let emittedKeys: Set<string>;

  // Assets: one inside the warranty window, one already lapsed, one far in the future, one with no
  // warranty. Only the first must produce a notification.
  const assets: Asset[] = [
    {
      id: 'asset-soon',
      name: 'MacBook Pro',
      assetTag: 'LZT-001',
      warrantyEnd: new Date(Date.now() + 10 * DAY), // inside the 90-day window
      deletedAt: null,
    },
    {
      id: 'asset-lapsed',
      name: 'Old ThinkPad',
      assetTag: null,
      warrantyEnd: new Date(Date.now() - DAY), // already lapsed → excluded
      deletedAt: null,
    },
    {
      id: 'asset-far',
      name: 'New Server',
      assetTag: 'LZT-009',
      warrantyEnd: new Date(Date.now() + 400 * DAY), // beyond the window → excluded
      deletedAt: null,
    },
    {
      id: 'asset-none',
      name: 'Monitor',
      assetTag: null,
      warrantyEnd: null, // no warranty → excluded
      deletedAt: null,
    },
  ];

  // Grants: one active inside the 14-day window, one already revoked, one far out, one permanent.
  const grants: Grant[] = [
    {
      id: 'grant-soon',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 5 * DAY), // inside the 14-day window
      application: { id: 'app-1', name: 'GitHub' },
      user: { firstName: 'Ada', lastName: 'Lovelace' },
    },
    {
      id: 'grant-revoked',
      userId: 'user-2',
      revokedAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + 5 * DAY), // revoked → excluded
      application: { id: 'app-1', name: 'GitHub' },
      user: { firstName: 'Alan', lastName: 'Turing' },
    },
    {
      id: 'grant-far',
      userId: 'user-3',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 90 * DAY), // beyond the window → excluded
      application: { id: 'app-2', name: 'AWS' },
      user: { firstName: 'Grace', lastName: 'Hopper' },
    },
    {
      id: 'grant-permanent',
      userId: 'user-4',
      revokedAt: null,
      expiresAt: null, // no expiry → excluded
      application: { id: 'app-2', name: 'AWS' },
      user: { firstName: 'Edsger', lastName: 'Dijkstra' },
    },
  ];

  beforeEach(async () => {
    emittedKeys = new Set<string>();
    // Simulate the real emit(): idempotent on dedupeKey. First emit for a key returns a new id; a repeat
    // of the SAME key (the daily re-scan) collapses to a no-op and returns null — exactly the
    // Notification.dedupeKey UNIQUE swallow the sweeper relies on for anti-spam.
    emit = jest.fn((input: EmitNotificationInput) => {
      if (emittedKeys.has(input.dedupeKey)) return Promise.resolve(null);
      emittedKeys.add(input.dedupeKey);
      return Promise.resolve(`notif-${emittedKeys.size}`);
    });

    const assetFindMany = jest.fn(
      (args: {
        where: { warrantyEnd: { gt: Date; lte: Date } };
        take: number;
      }) => {
        const { gt, lte } = args.where.warrantyEnd;
        const matched = assets
          .filter(
            (a) =>
              a.deletedAt === null &&
              a.warrantyEnd !== null &&
              a.warrantyEnd.getTime() > gt.getTime() &&
              a.warrantyEnd.getTime() <= lte.getTime(),
          )
          .slice(0, args.take)
          .map((a) => ({
            id: a.id,
            name: a.name,
            assetTag: a.assetTag,
            warrantyEnd: a.warrantyEnd,
          }));
        return Promise.resolve(matched);
      },
    );

    const grantFindMany = jest.fn(
      (args: {
        where: { revokedAt: null; expiresAt: { gt: Date; lte: Date } };
        take: number;
      }) => {
        const { gt, lte } = args.where.expiresAt;
        const matched = grants
          .filter(
            (g) =>
              g.revokedAt === null &&
              g.expiresAt !== null &&
              g.expiresAt.getTime() > gt.getTime() &&
              g.expiresAt.getTime() <= lte.getTime(),
          )
          .slice(0, args.take)
          .map((g) => ({
            id: g.id,
            userId: g.userId,
            expiresAt: g.expiresAt,
            application: g.application,
            user: g.user,
          }));
        return Promise.resolve(matched);
      },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpiryNotificationsSweeper,
        {
          provide: PrismaService,
          useValue: {
            asset: { findMany: assetFindMany },
            accessGrant: { findMany: grantFindMany },
          },
        },
        { provide: NotificationsService, useValue: { emit } },
      ],
    }).compile();

    sweeper = moduleRef.get(ExpiryNotificationsSweeper);
  });

  it('emits exactly one warranty + one grant nudge for the items inside the windows', async () => {
    const count = await sweeper.sweep();

    // Only the in-window asset + the in-window grant — never the lapsed / far-future / no-expiry /
    // revoked ones. Exactly two calls (toHaveBeenCalledTimes) proves the excluded rows are skipped.
    expect(count).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);

    // The dedupe key pins ONE row per item per expiry DATE — computed off the fixture dates so the match
    // is exact and deterministic (dayStamp keys off the item's expiry, not `now`).
    const warrantyStamp = assets[0].warrantyEnd?.toISOString().slice(0, 10);
    const grantStamp = grants[0].expiresAt?.toISOString().slice(0, 10);

    // The warranty nudge: deep-links to the asset. Broadcast — the emit input omits recipientUserId
    // entirely (asserted below), so the service records it in the admin feed.
    const warrantyCall = emit.mock.calls.find(
      (c) => c[0].type === 'warranty_expiring',
    );
    expect(warrantyCall?.[0]).not.toHaveProperty('recipientUserId');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warranty_expiring',
        entityType: 'asset',
        entityId: 'asset-soon',
        dedupeKey: `warranty_expiring:asset-soon:${warrantyStamp}`,
      }),
    );

    // The grant nudge: broadcast (recipientUserId omitted) but ABOUT the grantee (targetUserId),
    // deep-links to the application.
    const grantCall = emit.mock.calls.find(
      (c) => c[0].type === 'access_grant_expiring',
    );
    expect(grantCall?.[0]).not.toHaveProperty('recipientUserId');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'access_grant_expiring',
        targetUserId: 'user-1',
        entityType: 'application',
        entityId: 'app-1',
        dedupeKey: `access_grant_expiring:grant-soon:${grantStamp}`,
      }),
    );
  });

  it('does NOT re-emit on a second run — the dedupeKey collapses the daily re-scan to a no-op', async () => {
    const first = await sweeper.sweep();
    expect(first).toBe(2);

    // Second pass finds the SAME items and calls emit again with identical dedupeKeys, but every emit is
    // swallowed (returns null) → zero NEW notifications. No once-per-day spam.
    const second = await sweeper.sweep();
    expect(second).toBe(0);

    // emit was invoked again (4 total) but produced no new rows — the anti-spam guarantee.
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emittedKeys.size).toBe(2);
  });

  it('both proactive types are emailable, so the per-type email opt-out applies to them', () => {
    // The opt-out is an email-channel filter keyed on the emailable allowlist (#879); a type must be
    // emailable to be opt-out-able. Adding both to EMAIL_NOTIFICATION_TYPES is what wires that up.
    expect(isEmailableNotificationType('warranty_expiring')).toBe(true);
    expect(isEmailableNotificationType('access_grant_expiring')).toBe(true);
  });
});
