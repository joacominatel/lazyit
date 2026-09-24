import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Permission, UpdateAiSettings } from '@lazyit/shared';

jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import type { ServiceAccount, User } from '../../../generated/prisma/client';
import { EnvelopeKeyMissingError } from '../../common/crypto/envelope-cipher';
import { PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import type { Principal } from '../../auth/principal';
import { AiSettingsController } from './ai-settings.controller';

const ADMIN = { id: 'admin-1', role: 'ADMIN' } as User;
const MEMBER = { id: 'member-1', role: 'MEMBER' } as User;

function servicePrincipal(perms: Permission[]): Principal {
  return {
    kind: 'service',
    serviceAccount: { id: 'sa-1' } as ServiceAccount,
    permissions: new Set(perms),
  };
}

const HANDLERS = ['get', 'update', 'test', 'models'] as const;

/** An ExecutionContext for `handler` carrying `principal`. */
function ctx(handler: (typeof HANDLERS)[number], principal: Principal) {
  const request = {
    principal,
    user: principal.kind === 'human' ? principal.user : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => AiSettingsController.prototype[handler],
    getClass: () => AiSettingsController,
  } as never;
}

/** The two guards as the app runs them: the global RolesGuard, then the class-bound SA guard. */
async function authorize(
  handler: (typeof HANDLERS)[number],
  principal: Principal,
) {
  const resolver = {
    // The seed: only ADMIN holds settings:manage.
    hasAll: jest.fn((role: string, perms: Permission[]) =>
      Promise.resolve(role === 'ADMIN' || !perms.includes('settings:manage')),
    ),
  };
  const roles = new RolesGuard(new Reflector(), resolver as never);
  await roles.canActivate(ctx(handler, principal));
  return new ServicePrincipalForbiddenGuard().canActivate(
    ctx(handler, principal),
  );
}

describe('AiSettingsController — authorization', () => {
  const reflector = new Reflector();

  it('every route requires settings:manage (class-level)', () => {
    expect(reflector.get(PERMISSION_KEY, AiSettingsController)).toEqual([
      'settings:manage',
    ]);
    for (const handler of HANDLERS) {
      expect(
        reflector.getAllAndOverride(PERMISSION_KEY, [
          AiSettingsController.prototype[handler],
          AiSettingsController,
        ]),
      ).toEqual(['settings:manage']);
    }
  });

  it('is human-only (ServicePrincipalForbiddenGuard at class level)', () => {
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, AiSettingsController) as
        | unknown[]
        | undefined) ?? [];
    expect(guards).toContain(ServicePrincipalForbiddenGuard);
  });

  it.each(HANDLERS)(
    '%s: a non-settings:manage human gets 403',
    async (handler) => {
      await expect(
        authorize(handler, { kind: 'human', user: MEMBER }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each(HANDLERS)('%s: an admin passes', async (handler) => {
    await expect(
      authorize(handler, { kind: 'human', user: ADMIN }),
    ).resolves.toBe(true);
  });

  it.each(HANDLERS)(
    '%s: a service account is refused even when it holds settings:manage (ADR-0048)',
    async (handler) => {
      await expect(
        authorize(handler, servicePrincipal(['settings:manage'])),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        authorize(handler, servicePrincipal([])),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});

describe('AiSettingsController — handlers', () => {
  function makeController() {
    const service = {
      getSettings: jest.fn(() => Promise.resolve({ apiKeySet: true })),
      updateSettings: jest.fn(() => Promise.resolve({ apiKeySet: true })),
      testConnection: jest.fn(() => Promise.resolve({ ok: true })),
      listModels: jest.fn(() => Promise.resolve({ models: [] })),
    };
    return { controller: new AiSettingsController(service as never), service };
  }

  it('update passes the acting admin id to the service', async () => {
    const { controller, service } = makeController();
    const dto = { enabled: false } as UpdateAiSettings;
    await controller.update(dto, ADMIN);
    expect(service.updateSettings).toHaveBeenCalledWith(dto, 'admin-1');
  });

  it('maps a key write without AI_SECRET_KEY to 409', async () => {
    const { controller, service } = makeController();
    service.updateSettings.mockRejectedValueOnce(
      new EnvelopeKeyMissingError('AI_SECRET_KEY'),
    );
    const err = await controller
      .update({} as never, ADMIN)
      .catch((e: unknown) => e as ConflictException);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'AI_SECRET_KEY_MISSING',
      message: expect.stringContaining('AI_SECRET_KEY') as unknown,
    });
  });

  it('test and models forward the draft', async () => {
    const { controller, service } = makeController();
    await controller.test({ provider: 'anthropic' } as never);
    await controller.models({ provider: 'openai' } as never);
    expect(service.testConnection).toHaveBeenCalledWith({
      provider: 'anthropic',
    });
    expect(service.listModels).toHaveBeenCalledWith({ provider: 'openai' });
  });
});
