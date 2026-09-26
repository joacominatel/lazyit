import { Test } from '@nestjs/testing';
import {
  UserPreferencesService,
  toThemePreference,
  toUiLocale,
} from './user-preferences.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

describe('UserPreferencesService (issue #1422)', () => {
  let service: UserPreferencesService;
  let user: { findFirstOrThrow: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    user = { findFirstOrThrow: jest.fn(), update: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UserPreferencesService,
        { provide: PrismaService, useValue: { user } },
      ],
    }).compile();
    service = moduleRef.get(UserPreferencesService);
  });

  it('reads null/null for a user who never chose (every pre-upgrade row)', async () => {
    user.findFirstOrThrow.mockResolvedValue({ locale: null, theme: null });
    await expect(service.get('u-1')).resolves.toEqual({
      locale: null,
      theme: null,
    });
    expect(user.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      select: { locale: true, theme: true },
    });
  });

  it('reads the stored values', async () => {
    user.findFirstOrThrow.mockResolvedValue({ locale: 'es', theme: 'dark' });
    await expect(service.get('u-1')).resolves.toEqual({
      locale: 'es',
      theme: 'dark',
    });
  });

  it('is tolerant on read: an unknown stored value reads as null', async () => {
    user.findFirstOrThrow.mockResolvedValue({ locale: 'fr', theme: 'sepia' });
    await expect(service.get('u-1')).resolves.toEqual({
      locale: null,
      theme: null,
    });
  });

  it('writes only the keys sent (omitted = unchanged)', async () => {
    user.update.mockResolvedValue({ locale: 'es', theme: 'light' });
    await expect(service.update('u-1', { locale: 'es' })).resolves.toEqual({
      locale: 'es',
      theme: 'light',
    });
    expect(user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { locale: 'es' },
      select: { locale: true, theme: true },
    });
  });

  it('null clears a preference back to never chosen', async () => {
    user.update.mockResolvedValue({ locale: 'en', theme: null });
    await service.update('u-1', { theme: null });
    expect(user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { theme: null } }),
    );
  });

  it('the projection helpers accept only the catalog', () => {
    expect(toUiLocale('en')).toBe('en');
    expect(toUiLocale(undefined)).toBeNull();
    expect(toUiLocale('EN')).toBeNull();
    expect(toThemePreference('system')).toBe('system');
    expect(toThemePreference('')).toBeNull();
  });
});
