import { ActorService } from '../common/actor.service';

// Mock the generated Prisma client so importing the services never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ConsumablesService } from '../consumables/consumables.service';

/**
 * The bell EMITTERS (ADR-0056 §3) — proving each fires on the RIGHT condition, is POST-COMMIT +
 * BEST-EFFORT (a failed/throwing emit never affects the domain write), uses the `(type, entityId)`
 * dedupe key, and that low_stock fires only on the DOWNWARD crossing (the anti-flap guard).
 *
 * The services are built directly with mocked Prisma + a real ActorService. The workflow trigger is a
 * null-plan stub (no engine run fires), so the grant/movement behaviour is otherwise unchanged.
 */

const APP_ID = 'app-cuid-1';
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONSUMABLE_ID = 'cons-cuid-1';

describe('AccessGrant.create emitters (critical_app_access + admin_granted)', () => {
  let notifications: { emit: jest.Mock };
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock };
    application: { findFirst: jest.Mock; findUnique: jest.Mock };
    accessGrant: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: AccessGrantsService;

  const buildGrant = (accessLevel: string | null) => ({
    id: 'grant-1',
    userId: USER_ID,
    applicationId: APP_ID,
    accessLevel,
  });

  beforeEach(() => {
    notifications = { emit: jest.fn().mockResolvedValue('notif-1') };
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: USER_ID }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' }),
      },
      application: {
        findFirst: jest.fn().mockResolvedValue({ id: APP_ID }),
        findUnique: jest.fn(),
      },
      accessGrant: { create: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        cb({ accessGrant: prisma.accessGrant }),
      ),
    };
    const trigger = {
      planForTrigger: jest.fn().mockResolvedValue(null),
      buildRunData: jest.fn(),
      enqueue: jest.fn().mockResolvedValue(true),
    };
    service = new AccessGrantsService(
      prisma as never,
      new ActorService(),
      trigger as never,
      notifications as never,
    );
  });

  it('emits critical_app_access when the application isCritical (and links the app + grantee)', async () => {
    prisma.accessGrant.create.mockResolvedValue(buildGrant('viewer'));
    prisma.application.findUnique.mockResolvedValue({
      name: 'Prod DB',
      isCritical: true,
    });

    await service.create({ userId: USER_ID, applicationId: APP_ID });

    const calls = notifications.emit.mock.calls.map((c) => c[0]);
    const critical = calls.find((c) => c.type === 'critical_app_access');
    expect(critical).toBeDefined();
    expect(critical.dedupeKey).toBe('critical_app_access:grant-1');
    expect(critical).toMatchObject({
      entityType: 'application',
      entityId: APP_ID,
      targetUserId: USER_ID,
    });
    // Not an admin grant → no admin_granted.
    expect(calls.some((c) => c.type === 'admin_granted')).toBe(false);
  });

  it('does NOT emit critical_app_access for a non-critical application', async () => {
    prisma.accessGrant.create.mockResolvedValue(buildGrant('viewer'));
    prisma.application.findUnique.mockResolvedValue({
      name: 'Wiki',
      isCritical: false,
    });
    await service.create({ userId: USER_ID, applicationId: APP_ID });
    const types = notifications.emit.mock.calls.map((c) => c[0].type);
    expect(types).not.toContain('critical_app_access');
  });

  it('emits admin_granted when accessLevel is admin-level (case-insensitive)', async () => {
    prisma.accessGrant.create.mockResolvedValue(buildGrant('Admin'));
    prisma.application.findUnique.mockResolvedValue({
      name: 'Wiki',
      isCritical: false,
    });
    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'Admin',
    });
    const admin = notifications.emit.mock.calls
      .map((c) => c[0])
      .find((c) => c.type === 'admin_granted');
    expect(admin).toBeDefined();
    expect(admin.dedupeKey).toBe('admin_granted:grant-1');
  });

  it('is BEST-EFFORT + POST-COMMIT: a throwing emit never fails the grant (create still returns)', async () => {
    const grant = buildGrant('admin');
    prisma.accessGrant.create.mockResolvedValue(grant);
    prisma.application.findUnique.mockResolvedValue({
      name: 'Prod DB',
      isCritical: true,
    });
    notifications.emit.mockRejectedValue(new Error('bell down'));

    const result = await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'admin',
    });
    // The grant is returned despite the emit blowing up — the notification is decoupled.
    expect(result).toBe(grant);
  });
});

describe('Consumable.createMovement low_stock emitter (downward-crossing + dedupe)', () => {
  let notifications: { emit: jest.Mock };
  let consumable: { findFirst: jest.Mock };
  let txConsumable: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  let txMovement: { create: jest.Mock };
  let prisma: {
    consumable: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: ConsumablesService;

  beforeEach(() => {
    notifications = { emit: jest.fn().mockResolvedValue('notif-1') };
    consumable = { findFirst: jest.fn() };
    txConsumable = {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    txMovement = { create: jest.fn().mockResolvedValue({ id: 1, type: 'OUT' }) };
    prisma = {
      consumable,
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        cb({ consumable: txConsumable, consumableMovement: txMovement }),
      ),
    };
    service = new ConsumablesService(
      prisma as never,
      new ActorService(),
      notifications as never,
    );
  });

  it('emits low_stock on a DOWNWARD crossing (above min → at/below min)', async () => {
    // before: 6 (> min 5). after: 4 (<= 5) → crossing.
    consumable.findFirst
      .mockResolvedValueOnce({ currentStock: 6, minStock: 5, name: 'HDMI' }) // before
      .mockResolvedValueOnce({ currentStock: 4, name: 'HDMI' }); // after

    await service.createMovement(CONSUMABLE_ID, { type: 'OUT', quantity: 2 });

    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const emitted = notifications.emit.mock.calls[0]![0];
    expect(emitted.type).toBe('low_stock');
    expect(emitted.entityType).toBe('consumable');
    expect(emitted.entityId).toBe(CONSUMABLE_ID);
    // Dedupe key carries the consumable id + a daily bucket (anti-flap; one per day).
    expect(emitted.dedupeKey).toMatch(
      new RegExp(`^low_stock:${CONSUMABLE_ID}:\\d{4}-\\d{2}-\\d{2}$`),
    );
  });

  it('does NOT emit when ALREADY at/below min before the movement (flap guard, no re-fire)', async () => {
    // before: 4 (already <= min 5) → not a downward crossing even though after is also low.
    consumable.findFirst.mockResolvedValueOnce({
      currentStock: 4,
      minStock: 5,
      name: 'HDMI',
    });
    await service.createMovement(CONSUMABLE_ID, { type: 'OUT', quantity: 1 });
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when the consumable has no minStock threshold', async () => {
    consumable.findFirst.mockResolvedValueOnce({
      currentStock: 6,
      minStock: null,
      name: 'HDMI',
    });
    await service.createMovement(CONSUMABLE_ID, { type: 'OUT', quantity: 2 });
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when stock stays ABOVE min after the movement (no crossing)', async () => {
    consumable.findFirst
      .mockResolvedValueOnce({ currentStock: 10, minStock: 5, name: 'HDMI' }) // before
      .mockResolvedValueOnce({ currentStock: 8, name: 'HDMI' }); // after (still > 5)
    await service.createMovement(CONSUMABLE_ID, { type: 'OUT', quantity: 2 });
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('is BEST-EFFORT: a throwing low_stock emit never fails the movement (returns the ledger row)', async () => {
    consumable.findFirst
      .mockResolvedValueOnce({ currentStock: 6, minStock: 5, name: 'HDMI' })
      .mockResolvedValueOnce({ currentStock: 4, name: 'HDMI' });
    notifications.emit.mockRejectedValue(new Error('bell down'));

    const row = await service.createMovement(CONSUMABLE_ID, {
      type: 'OUT',
      quantity: 2,
    });
    expect(row).toMatchObject({ id: 1, type: 'OUT' });
  });
});
