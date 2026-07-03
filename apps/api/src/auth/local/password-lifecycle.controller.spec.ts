import { UnauthorizedException } from '@nestjs/common';

// Keep the real generated Prisma client out of this unit test — the controller transitively imports
// PasswordLifecycleService → PrismaService, which loads it at module scope. The controller gets a fully
// mocked service anyway.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { PasswordLifecycleController } from './password-lifecycle.controller';
import type { PasswordLifecycleService } from './password-lifecycle.service';

/**
 * PasswordLifecycleController unit tests (ADR-0086 §F4). Verifies the thin controller contract: the
 * UNIFORM forgot/reset bodies (produced HERE, not in the service — the enumeration-safe surface), the
 * change-password delegation + the anonymous-caller 401.
 */
describe('PasswordLifecycleController (ADR-0086 §F4)', () => {
  let service: {
    changePassword: jest.Mock;
    forgotPassword: jest.Mock;
    resetPassword: jest.Mock;
  };
  let controller: PasswordLifecycleController;

  beforeEach(() => {
    service = {
      changePassword: jest.fn().mockResolvedValue({ token: 'new-token' }),
      forgotPassword: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue(undefined),
    };
    controller = new PasswordLifecycleController(
      service as unknown as PasswordLifecycleService,
    );
  });

  it('change-password delegates to the service and returns the fresh token', async () => {
    const user = { id: 'u1' } as never;
    const res = await controller.changePassword(
      { currentPassword: 'old', newPassword: 'NewPass1!' },
      user,
    );
    expect(service.changePassword).toHaveBeenCalledWith(
      user,
      'old',
      'NewPass1!',
    );
    expect(res).toEqual({ token: 'new-token' });
  });

  it('change-password 401s an anonymous caller (no @CurrentUser)', async () => {
    await expect(
      controller.changePassword(
        { currentPassword: 'old', newPassword: 'NewPass1!' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.changePassword).not.toHaveBeenCalled();
  });

  it('forgot-password returns the UNIFORM { ok: true } body regardless of the service outcome', async () => {
    const res = await controller.forgotPassword({
      identifier: 'anyone@example.com',
    });
    expect(res).toEqual({ ok: true });
    expect(service.forgotPassword).toHaveBeenCalledWith('anyone@example.com');
  });

  it('reset-password returns { ok: true } and delegates the token + new password', async () => {
    const res = await controller.resetPassword({
      token: 'raw',
      newPassword: 'NewPass1!',
    });
    expect(res).toEqual({ ok: true });
    expect(service.resetPassword).toHaveBeenCalledWith('raw', 'NewPass1!');
  });
});
