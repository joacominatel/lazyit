import { Logger } from '@nestjs/common';

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
import { LocalIdentityProvider } from './local.identity-provider';
import { PasswordResetUnsupportedError } from './identity-provider.interface';

describe('createIdentityProvider (ADR-0102 §4)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('defaults to generic-oidc when IDENTITY_PROVIDER_TYPE is unset under AUTH_MODE=oidc, without a warning', () => {
    const provider = createIdentityProvider(undefined, 'oidc');
    expect(provider).toBeInstanceOf(GenericOidcIdentityProvider);
    expect(provider.kind).toBe('generic-oidc');
    expect(provider.supportsManagement).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns generic-oidc for an explicit "generic-oidc" (case/space-insensitive), without a warning', () => {
    expect(createIdentityProvider('generic-oidc', 'oidc')).toBeInstanceOf(
      GenericOidcIdentityProvider,
    );
    expect(createIdentityProvider('  Generic-OIDC ', 'oidc')).toBeInstanceOf(
      GenericOidcIdentityProvider,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('maps a legacy "zitadel" value to generic-oidc with exactly one warning (never fails boot)', () => {
    const provider = createIdentityProvider('ZITADEL', 'oidc');
    expect(provider).toBeInstanceOf(GenericOidcIdentityProvider);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('IDENTITY_PROVIDER_TYPE=zitadel'),
    );
  });

  it('maps an unrecognized value to generic-oidc with one warning', () => {
    expect(createIdentityProvider('okta', 'oidc')).toBeInstanceOf(
      GenericOidcIdentityProvider,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('uses generic-oidc under AUTH_MODE=shim too', () => {
    expect(createIdentityProvider(undefined, 'shim')).toBeInstanceOf(
      GenericOidcIdentityProvider,
    );
  });

  // ADR-0086 §5 (F1c): AUTH_MODE=local selects the no-op LocalIdentityProvider, IGNORING the IdP type.
  it('returns the LocalIdentityProvider when AUTH_MODE=local, regardless of IDENTITY_PROVIDER_TYPE', () => {
    for (const rawType of [undefined, 'zitadel', 'generic-oidc', 'okta']) {
      const provider = createIdentityProvider(rawType, 'local');
      expect(provider).toBeInstanceOf(LocalIdentityProvider);
      expect(provider.kind).toBe('local');
      expect(provider.supportsManagement).toBe(false);
    }
    // Case/space-insensitive on AUTH_MODE.
    expect(createIdentityProvider('zitadel', '  LOCAL ')).toBeInstanceOf(
      LocalIdentityProvider,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('LocalIdentityProvider (AUTH_MODE=local — ADR-0086 §5, pure no-op)', () => {
  let provider: LocalIdentityProvider;

  beforeEach(() => {
    provider = new LocalIdentityProvider();
  });

  it('advertises kind=local and no management (nothing to mirror to)', () => {
    expect(provider.kind).toBe('local');
    expect(provider.supportsManagement).toBe(false);
  });

  it('no-ops every mirror method (createUser returns an empty ref)', async () => {
    await expect(
      provider.createUser({
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'VIEWER',
      }),
    ).resolves.toEqual({ externalId: '' });
    await expect(provider.deactivateUser('ext-1')).resolves.toBeUndefined();
    await expect(provider.grantRole('ext-1', 'ADMIN')).resolves.toBeUndefined();
    await expect(
      provider.revokeRole('ext-1', 'ADMIN'),
    ).resolves.toBeUndefined();
    await expect(
      provider.updateUser('ext-1', { firstName: 'New' }),
    ).resolves.toBeUndefined();
  });

  it('rejects requestPasswordReset (local reset is handled directly, never via the IdP seam)', async () => {
    await expect(provider.requestPasswordReset('ext-1')).rejects.toBeInstanceOf(
      PasswordResetUnsupportedError,
    );
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

  it('no-ops updateUser (profile/email write-back) with a warn — issue #149', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      provider.updateUser('ext-1', { firstName: 'New', email: 'new@b.com' }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('management not supported for generic OIDC IdP'),
    );
    warnSpy.mockRestore();
  });

  it('REJECTS requestPasswordReset with PasswordResetUnsupportedError (honest, not a silent no-op) — issue #149', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    // Unlike the mirror writes, a reset is a user-visible ACTION: a silent no-op would falsely imply a
    // reset was sent. BYOI must reject so the controller can surface an honest 501 (INV-4).
    await expect(provider.requestPasswordReset('ext-1')).rejects.toBeInstanceOf(
      PasswordResetUnsupportedError,
    );

    warnSpy.mockRestore();
  });
});
