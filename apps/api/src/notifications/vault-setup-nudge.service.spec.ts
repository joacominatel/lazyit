import { Test } from '@nestjs/testing';
import { VaultSetupNudgeService } from './vault-setup-nudge.service';
import { NotificationsService } from './notifications.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '../../generated/prisma/client';

// No DB: the service only ever reads userKeypair.findFirst.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const baseUser = { id: USER_ID, role: 'ADMIN' } as unknown as User;

/**
 * VaultSetupNudgeService (ADR-0056 amendment, #453) — the login-time vault-setup nudge. Proves:
 *   - emits a ONE-TIME TARGETED notification only when the caller holds `secret:read` AND has no keypair;
 *   - does NOT emit when they lack `secret:read`, or when a keypair already exists;
 *   - the dedupeKey is the STABLE `secret.vault_setup:<userId>` (idempotent — one nudge per user, ever);
 *   - is FAIL-SOFT: any error (permission resolve, keypair lookup, emit) is swallowed, never thrown.
 */
describe('VaultSetupNudgeService', () => {
  let service: VaultSetupNudgeService;
  const hasAll = jest.fn();
  const findFirst = jest.fn();
  const emit = jest.fn();

  beforeEach(async () => {
    hasAll.mockReset();
    findFirst.mockReset();
    emit.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VaultSetupNudgeService,
        {
          provide: PrismaService,
          useValue: { userKeypair: { findFirst } },
        },
        { provide: PermissionResolverService, useValue: { hasAll } },
        { provide: NotificationsService, useValue: { emit } },
      ],
    }).compile();
    service = moduleRef.get(VaultSetupNudgeService);
  });

  it('emits a ONE-TIME TARGETED secret.vault_setup nudge for a secret:read holder with no keypair', async () => {
    hasAll.mockResolvedValue(true); // holds secret:read
    findFirst.mockResolvedValue(null); // no UserKeypair
    emit.mockResolvedValue('n1');

    await service.notifyIfVaultSetupNeeded(baseUser);

    expect(hasAll).toHaveBeenCalledWith('ADMIN', ['secret:read']);
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      select: { id: true },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg).toMatchObject({
      type: 'secret.vault_setup',
      // The STABLE dedupeKey (no time bucket) — one nudge per user, ever (idempotent via @unique).
      dedupeKey: `secret.vault_setup:${USER_ID}`,
      recipientUserId: USER_ID, // TARGETED to the user's own bell
    });
    // INV-10: carries no secret value / no key material — only copy + (type-driven) link.
    expect(JSON.stringify(arg)).not.toMatch(/privateKey|passphrase[A-Z]|recovery|ciphertext|dek/i);
    expect(arg.title).toBeTruthy();
  });

  it('does NOT emit when the user lacks secret:read (never even checks the keypair)', async () => {
    hasAll.mockResolvedValue(false);
    await service.notifyIfVaultSetupNeeded(baseUser);
    expect(findFirst).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT emit when the user already has a keypair (vault already set up)', async () => {
    hasAll.mockResolvedValue(true);
    findFirst.mockResolvedValue({ id: 'kp1' });
    await service.notifyIfVaultSetupNeeded(baseUser);
    expect(emit).not.toHaveBeenCalled();
  });

  it('relies on emit dedupe for idempotency: re-login re-runs the check but emit collapses to the same row', async () => {
    hasAll.mockResolvedValue(true);
    findFirst.mockResolvedValue(null);
    // First login emits; a second login (still no keypair) calls emit again with the SAME dedupeKey —
    // emit is itself idempotent (returns null on the @unique collision), so no duplicate notification.
    emit.mockResolvedValueOnce('n1').mockResolvedValueOnce(null);
    await service.notifyIfVaultSetupNeeded(baseUser);
    await service.notifyIfVaultSetupNeeded(baseUser);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0].dedupeKey).toBe(
      emit.mock.calls[1]![0].dedupeKey,
    );
  });

  it('is FAIL-SOFT: a permission-resolve error is swallowed, never thrown (login is never blocked)', async () => {
    hasAll.mockRejectedValue(new Error('resolver down'));
    await expect(
      service.notifyIfVaultSetupNeeded(baseUser),
    ).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is FAIL-SOFT: a keypair-lookup error is swallowed, never thrown', async () => {
    hasAll.mockResolvedValue(true);
    findFirst.mockRejectedValue(new Error('db down'));
    await expect(
      service.notifyIfVaultSetupNeeded(baseUser),
    ).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is FAIL-SOFT: an emit error is swallowed, never thrown', async () => {
    hasAll.mockResolvedValue(true);
    findFirst.mockResolvedValue(null);
    emit.mockRejectedValue(new Error('emit boom'));
    await expect(
      service.notifyIfVaultSetupNeeded(baseUser),
    ).resolves.toBeUndefined();
  });
});
