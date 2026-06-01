import { Logger, NotImplementedException } from '@nestjs/common';

// The providers import the generated Prisma client only for the `Role` TYPE (import type), which is
// erased at compile time — but jest still resolves the module graph, so stub it to avoid loading the
// real client (no DB needed for these pure unit tests).
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { createIdentityProvider } from './identity-provider.factory';
import { GenericOidcIdentityProvider } from './generic-oidc.identity-provider';
import { ZitadelIdentityProvider } from './zitadel.identity-provider';

describe('createIdentityProvider (ADR-0043 factory)', () => {
  it('returns the Zitadel provider for "zitadel"', () => {
    const provider = createIdentityProvider('zitadel');
    expect(provider).toBeInstanceOf(ZitadelIdentityProvider);
    expect(provider.kind).toBe('zitadel');
    expect(provider.supportsManagement).toBe(true);
  });

  it('returns the generic-oidc provider for "generic-oidc"', () => {
    const provider = createIdentityProvider('generic-oidc');
    expect(provider).toBeInstanceOf(GenericOidcIdentityProvider);
    expect(provider.kind).toBe('generic-oidc');
    expect(provider.supportsManagement).toBe(false);
  });

  it('is case-insensitive and trims the env value', () => {
    expect(createIdentityProvider('  Generic-OIDC ')).toBeInstanceOf(
      GenericOidcIdentityProvider,
    );
    expect(createIdentityProvider('ZITADEL')).toBeInstanceOf(
      ZitadelIdentityProvider,
    );
  });

  it('defaults to Zitadel when the value is unset', () => {
    expect(createIdentityProvider(undefined)).toBeInstanceOf(
      ZitadelIdentityProvider,
    );
  });

  it('falls back to Zitadel (with a warn) for an unrecognized value', () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const provider = createIdentityProvider('okta');

    expect(provider).toBeInstanceOf(ZitadelIdentityProvider);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('GenericOidcIdentityProvider (BYOI — ADR-0043 #5)', () => {
  let provider: GenericOidcIdentityProvider;

  beforeEach(() => {
    provider = new GenericOidcIdentityProvider();
  });

  it('resolves the external ref to { externalId: sub }', async () => {
    await expect(provider.resolveExternalRef('sub-123')).resolves.toEqual({
      externalId: 'sub-123',
    });
  });

  it('no-ops createUser and logs a "management not supported" warn', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      provider.createUser({
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'VIEWER',
      }),
    ).resolves.toEqual({ externalId: '' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('management not supported for generic OIDC IdP'),
    );
    warnSpy.mockRestore();
  });

  it('no-ops deactivateUser / grantRole / revokeRole and warns each time', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(provider.deactivateUser('ext-1')).resolves.toBeUndefined();
    await expect(provider.grantRole('ext-1', 'ADMIN')).resolves.toBeUndefined();
    await expect(
      provider.revokeRole('ext-1', 'ADMIN'),
    ).resolves.toBeUndefined();

    // One warn per management call.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('management not supported for generic OIDC IdP'),
    );
    warnSpy.mockRestore();
  });
});

describe('ZitadelIdentityProvider (STUB — ADR-0043 Phase 2)', () => {
  let provider: ZitadelIdentityProvider;

  beforeEach(() => {
    provider = new ZitadelIdentityProvider();
  });

  it('resolves the external ref to { externalId: sub }', async () => {
    await expect(provider.resolveExternalRef('zitadel-sub')).resolves.toEqual({
      externalId: 'zitadel-sub',
    });
  });

  it('throws NotImplementedException for the management methods (Phase 2)', async () => {
    await expect(
      provider.createUser({
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'VIEWER',
      }),
    ).rejects.toBeInstanceOf(NotImplementedException);
    await expect(provider.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    await expect(provider.grantRole('ext-1', 'ADMIN')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    await expect(provider.revokeRole('ext-1', 'ADMIN')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});
