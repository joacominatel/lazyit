import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PASSWORD_CHANGE_REQUIRED_CODE } from '@lazyit/shared';
import { MustChangePasswordGuard } from './must-change-password.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from './allow-password-change-required.decorator';

/**
 * MustChangePasswordGuard unit tests (ADR-0086 §F4, F4a control 2). The forced-change wall: in local mode
 * a mustChangePassword=true human is refused on every non-exempt route with a machine-readable
 * `403 { code: 'PASSWORD_CHANGE_REQUIRED' }`; exempt (public / @AllowPasswordChangeRequired) routes,
 * non-local modes, non-flagged users and non-human principals all pass through.
 */
describe('MustChangePasswordGuard (ADR-0086 §F4)', () => {
  let guard: MustChangePasswordGuard;
  let reflector: {
    getAllAndOverride: jest.Mock;
  };

  const prevMode = process.env.AUTH_MODE;

  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    guard = new MustChangePasswordGuard(reflector as unknown as Reflector);
  });

  afterAll(() => {
    process.env.AUTH_MODE = prevMode;
  });

  /** A minimal ExecutionContext exposing a request with the given user. */
  function ctx(user: unknown) {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as never;
  }

  function flaggedUser() {
    return { id: 'u1', mustChangePassword: true };
  }

  it('blocks a flagged human on a non-exempt route with a 403 carrying the code', () => {
    try {
      guard.canActivate(ctx(flaggedUser()));
      throw new Error('expected the guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const e = err as HttpException;
      expect(e.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(e.getResponse()).toMatchObject({
        code: PASSWORD_CHANGE_REQUIRED_CODE,
      });
    }
  });

  it('allows a flagged human on a @Public() route (no user to gate there anyway)', () => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === IS_PUBLIC_KEY ? true : undefined,
    );
    expect(guard.canActivate(ctx(flaggedUser()))).toBe(true);
  });

  it('allows a flagged human on an @AllowPasswordChangeRequired() route (change-password, /me)', () => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === ALLOW_PASSWORD_CHANGE_REQUIRED_KEY ? true : undefined,
    );
    expect(guard.canActivate(ctx(flaggedUser()))).toBe(true);
  });

  it('allows a human WITHOUT the flag through', () => {
    expect(
      guard.canActivate(ctx({ id: 'u1', mustChangePassword: false })),
    ).toBe(true);
  });

  it('allows an anonymous / service-principal request (no request.user) through', () => {
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });

  it('is a no-op outside local mode, even for a flagged user', () => {
    process.env.AUTH_MODE = 'oidc';
    expect(guard.canActivate(ctx(flaggedUser()))).toBe(true);
    // Never even consulted the exemption metadata (short-circuited on mode).
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });
});
