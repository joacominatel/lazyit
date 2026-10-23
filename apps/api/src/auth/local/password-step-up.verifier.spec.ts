import { LocalCredentialService } from './local-credential.service';
import { PasswordStepUpVerifier } from './password-step-up.verifier';
import type { PrismaService } from '../../prisma/prisma.service';
import { withGlobalOmit } from '../../../test/prisma/global-omit';

// Stub the generated Prisma client (the api CommonJS-Jest convention); PrismaService is mocked anyway.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// The step-up primitive reads the CURRENT hash by id through the dedicated credential read (ADR-0105):
// `passwordHash` is globally omitted, so neither the principal nor a default read carries it. The mock
// answers through `withGlobalOmit`, so a read that does not opt the hash back in fails here as it would
// against Postgres (the step-up would then refuse every password).

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('PasswordStepUpVerifier — the dedicated credential read (ADR-0105)', () => {
  const originalMode = process.env.AUTH_MODE;
  const credentials = new LocalCredentialService();
  let findFirst: jest.Mock;
  let verifier: PasswordStepUpVerifier;

  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    findFirst = jest.fn();
    verifier = new PasswordStepUpVerifier(
      credentials,
      withGlobalOmit({ user: { findFirst } }) as unknown as PrismaService,
    );
  });
  afterAll(() => {
    if (originalMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = originalMode;
  });

  it('verifies against the stored hash for a principal that carries none', async () => {
    findFirst.mockResolvedValue({
      id: USER_ID,
      passwordHash: await credentials.hash('right-pw'),
    });
    await expect(verifier.verify({ id: USER_ID }, 'right-pw')).resolves.toEqual(
      { ok: true },
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { passwordHash: true },
    });
  });

  it('refuses a wrong password', async () => {
    findFirst.mockResolvedValue({
      passwordHash: await credentials.hash('right-pw'),
    });
    await expect(verifier.verify({ id: USER_ID }, 'wrong-pw')).resolves.toEqual(
      { ok: false, reason: 'invalid' },
    );
  });

  it('fails closed for a user with no local password, or no live row', async () => {
    findFirst.mockResolvedValueOnce({ passwordHash: null });
    await expect(verifier.verify({ id: USER_ID }, 'x')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    findFirst.mockResolvedValueOnce(null);
    await expect(verifier.verify({ id: 'u2' }, 'x')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('hasPassword answers from the same read', async () => {
    findFirst.mockResolvedValueOnce({ passwordHash: 'stored' });
    await expect(verifier.hasPassword(USER_ID)).resolves.toBe(true);
    findFirst.mockResolvedValueOnce({ passwordHash: null });
    await expect(verifier.hasPassword(USER_ID)).resolves.toBe(false);
  });

  it('is unavailable outside local mode without reading anything', async () => {
    process.env.AUTH_MODE = 'oidc';
    await expect(verifier.verify({ id: USER_ID }, 'x')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
