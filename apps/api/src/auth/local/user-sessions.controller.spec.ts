// Keep the real generated Prisma client out of this unit test (the service imports PrismaService).
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserSessionsController } from './user-sessions.controller';
import type { UserSessionsService } from './user-sessions.service';
import { IS_PUBLIC_KEY } from '../public.decorator';
import { ServicePrincipalForbiddenGuard } from '../service-principal-forbidden.guard';

/** The thin `/auth/sessions` controller (issue #1420): authenticated humans only, own sessions only. */
describe('UserSessionsController (#1420)', () => {
  const SID = '33333333-3333-4333-8333-333333333333';
  let service: { list: jest.Mock; end: jest.Mock };
  let controller: UserSessionsController;

  beforeEach(() => {
    service = {
      list: jest
        .fn()
        .mockResolvedValue({ sessions: [], currentIsLegacy: true }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    controller = new UserSessionsController(
      service as unknown as UserSessionsService,
    );
  });

  it('refuses a service principal and is never public', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, UserSessionsController),
    ).toContain(ServicePrincipalForbiddenGuard);
    for (const name of ['list', 'end'] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        UserSessionsController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    }
  });

  it('lists with the calling session id from the guard (null for a pre-upgrade token)', async () => {
    const user = { id: 'u1' } as never;
    await controller.list(
      { localSession: { rememberMe: false, sessionId: SID } } as never,
      user,
    );
    expect(service.list).toHaveBeenCalledWith(user, SID);
    await controller.list({} as never, user);
    expect(service.list).toHaveBeenLastCalledWith(user, null);
  });

  it('ends the named session on behalf of the caller', async () => {
    const user = { id: 'u1' } as never;
    await controller.end(
      'target',
      { localSession: { rememberMe: false, sessionId: SID } } as never,
      user,
    );
    expect(service.end).toHaveBeenCalledWith(user, 'target', SID);
  });

  it('401s without a human caller', async () => {
    await expect(
      controller.list({} as never, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.end('x', {} as never, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
