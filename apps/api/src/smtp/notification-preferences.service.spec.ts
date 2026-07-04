import { BadRequestException } from '@nestjs/common';
import { NotificationPreferencesService } from './notification-preferences.service';
import { EMAIL_NOTIFICATION_TYPES } from './email.constants';
import type { PrismaService } from '../prisma/prisma.service';

// Stub the generated Prisma client so ts-jest never resolves its ESM `.js` imports (api Jest convention).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

describe('NotificationPreferencesService', () => {
  function setup(stored: string[] = []) {
    const update = jest
      .fn()
      .mockImplementation(
        ({ data }: { data: { notificationEmailOptOutTypes: string[] } }) =>
          Promise.resolve({
            notificationEmailOptOutTypes: data.notificationEmailOptOutTypes,
          }),
      );
    const prisma = {
      user: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ notificationEmailOptOutTypes: stored }),
        update,
      },
    } as unknown as PrismaService;
    return { service: new NotificationPreferencesService(prisma), update };
  }

  it('get() returns the full emailable catalog + the stored opt-outs', async () => {
    const { service } = setup(['low_stock']);
    const prefs = await service.get('u1');
    expect(prefs.emailableTypes).toEqual([...EMAIL_NOTIFICATION_TYPES]);
    expect(prefs.optedOutTypes).toEqual(['low_stock']);
  });

  it('update() stores a de-duplicated emailable set and echoes it', async () => {
    const { service, update } = setup();
    const prefs = await service.update('u1', [
      'low_stock',
      'low_stock',
      'admin_granted',
    ]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { notificationEmailOptOutTypes: ['low_stock', 'admin_granted'] },
      }),
    );
    expect(prefs.optedOutTypes).toEqual(['low_stock', 'admin_granted']);
  });

  it('update() rejects a non-emailable type with 400 (never writes)', async () => {
    const { service, update } = setup();
    // 'secret.vault_setup' is a valid NotificationType but NOT emailable (bell-only).
    await expect(
      service.update('u1', ['secret.vault_setup'] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});
