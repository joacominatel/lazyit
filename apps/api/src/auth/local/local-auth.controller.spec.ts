// Keep the real generated Prisma client out of this unit test — the controller transitively imports
// LoginService → PrismaService, which loads it at module scope. The controller gets a mocked service.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { LocalAuthController } from './local-auth.controller';
import type { LoginService } from './login.service';
import { IS_PUBLIC_KEY } from '../public.decorator';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../allow-password-change-required.decorator';

/**
 * LocalAuthController unit tests (ADR-0086 §3/§8). The thin controller contract: login forwards the
 * remember-me choice, and logout is an AUTHENTICATED route (never @Public) that stays reachable behind the
 * forced-change wall and delegates the server-side revocation.
 */
describe('LocalAuthController (ADR-0086 §3/§8)', () => {
  let service: { login: jest.Mock; logout: jest.Mock };
  let controller: LocalAuthController;

  beforeEach(() => {
    service = {
      login: jest.fn().mockResolvedValue({ token: 't', expiresAt: null }),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    controller = new LocalAuthController(service as unknown as LoginService);
  });

  it('login forwards identifier, password and the rememberMe choice', async () => {
    await controller.login({
      identifier: 'alice',
      password: 'pw',
      rememberMe: true,
    });
    expect(service.login).toHaveBeenCalledWith('alice', 'pw', true);
  });

  it('logout revokes the authenticated caller server-side', async () => {
    const user = { id: 'u1', sessionEpoch: 2 } as never;
    await controller.logout(user);
    expect(service.logout).toHaveBeenCalledWith(user);
  });

  it('logout is a no-op without a human user (service principal / anonymous shim)', async () => {
    await expect(controller.logout(undefined)).resolves.toBeUndefined();
    expect(service.logout).not.toHaveBeenCalled();
  });

  it('logout requires authentication and is exempt from the forced-change wall', () => {
    const handler = Object.getOwnPropertyDescriptor(
      LocalAuthController.prototype,
      'logout',
    )?.value as object;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, handler),
    ).toBe(true);
  });
});
