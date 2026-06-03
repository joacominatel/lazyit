import { Logger, ServiceUnavailableException } from '@nestjs/common';

// The ZitadelIdentityProvider transitively imports `jose` (ESM) via the management service; ts-jest
// cannot parse it. These tests never reach the signing path (they exercise the absent-config branch),
// so a minimal SignJWT stub is enough to let the module graph load.
jest.mock('jose', () => {
  class SignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setSubject() {
      return this;
    }
    setAudience() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    sign() {
      return Promise.resolve('signed.jwt.assertion');
    }
  }
  return { SignJWT };
});

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
import { PasswordResetUnsupportedError } from './identity-provider.interface';

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
    await expect(
      provider.requestPasswordReset('ext-1'),
    ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);

    warnSpy.mockRestore();
  });
});

describe('ZitadelIdentityProvider (write-back — ADR-0043 Phase 2)', () => {
  let provider: ZitadelIdentityProvider;
  // Snapshot the Management env so each test starts from a clean, deterministic config state.
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ZITADEL_MGMT_SA_KEY;
    delete process.env.ZITADEL_MGMT_SA_KEY_PATH;
    delete process.env.ZITADEL_MGMT_PROJECT_ID;
    delete process.env.ZITADEL_MGMT_API_URL;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_JWKS_URI;
    provider = new ZitadelIdentityProvider();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('resolves the external ref to { externalId: sub } without a Management call', async () => {
    await expect(provider.resolveExternalRef('zitadel-sub')).resolves.toEqual({
      externalId: 'zitadel-sub',
    });
  });

  it('advertises management support', () => {
    expect(provider.kind).toBe('zitadel');
    expect(provider.supportsManagement).toBe(true);
  });

  it('absent config: management methods throw "not configured" 503 (never blocks login)', async () => {
    // No ZITADEL_MGMT_* set. The provider was constructed without throwing (boot-safe); the
    // management methods reject with a clear ServiceUnavailableException (mapped to 503 upstream).
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
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(provider.deactivateUser('ext-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(provider.grantRole('ext-1', 'ADMIN')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(provider.revokeRole('ext-1', 'ADMIN')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Issue #149: the new write-backs degrade the same way — 503, never blocking login.
    await expect(
      provider.updateUser('ext-1', { email: 'new@b.com' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      provider.requestPasswordReset('ext-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // The absent credential is reported via a structured WARN, never blocking boot/login.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Zitadel management'),
    );
    warnSpy.mockRestore();
  });
});
