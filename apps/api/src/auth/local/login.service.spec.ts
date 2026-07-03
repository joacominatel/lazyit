import { UnauthorizedException } from '@nestjs/common';

// Keep the real generated Prisma client out of this unit test — PrismaService (imported transitively by
// LoginService) pulls it in at module load. LoginService receives a fully-mocked prisma instance anyway.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { hash as argon2Hash } from '@node-rs/argon2';
import { LoginService } from './login.service';
import { LocalCredentialService } from './local-credential.service';

/** A REAL argon2id hash produced with WEAKER params than the current target (m=4096 < 19456, t=1 < 2). */
function weakHash(password: string): Promise<string> {
  return argon2Hash(password, {
    algorithm: 2,
    memoryCost: 4096,
    timeCost: 1,
    parallelism: 1,
  });
}

/**
 * LoginService unit tests (ADR-0086 §3) — REAL LocalCredentialService (real argon2, so the constant-time
 * dummy-hash / fail-closed behaviour is genuinely exercised) with a MOCKED Prisma. Covers the security
 * controls: no-enumeration (unknown user and wrong password are indistinguishable), null-hash fail-closed,
 * the directoryOnly / inactive gates, rehash-on-login, and per-account exponential backoff.
 */

const VALID_ID = '11111111-1111-1111-1111-111111111111';

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string | null;
  role: string;
  isActive: boolean;
  directoryOnly: boolean;
  passwordHash: string | null;
  sessionEpoch: number;
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: VALID_ID,
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Smith',
    username: 'alice',
    role: 'MEMBER',
    isActive: true,
    directoryOnly: false,
    passwordHash: null,
    sessionEpoch: 0,
    ...overrides,
  };
}

describe('LoginService', () => {
  let credentials: LocalCredentialService;
  let findFirst: jest.Mock;
  let update: jest.Mock;
  let prisma: { user: { findFirst: jest.Mock; update: jest.Mock } };
  let service: LoginService;

  beforeAll(() => {
    process.env.SESSION_SIGNING_SECRET =
      'test-session-signing-secret-0123456789abcdef';
  });

  beforeEach(() => {
    credentials = new LocalCredentialService();
    findFirst = jest.fn();
    update = jest.fn().mockResolvedValue({});
    prisma = { user: { findFirst, update } };
    service = new LoginService(prisma as never, credentials);
  });

  it('logs in a valid user and returns a token + safe user (no passwordHash/epoch)', async () => {
    const hash = await credentials.hash('s3cret-pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));

    const res = await service.login('alice@example.com', 's3cret-pw');
    expect(typeof res.token).toBe('string');
    expect(res.user).toEqual({
      id: VALID_ID,
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      username: 'alice',
      role: 'MEMBER',
    });
    expect(res.user as Record<string, unknown>).not.toHaveProperty(
      'passwordHash',
    );
    // The token verifies and carries the current epoch.
    await expect(credentials.verifySession(res.token)).resolves.toEqual({
      sub: VALID_ID,
      epoch: 0,
    });
  });

  it('looks up by email OR username on the LIVE client, never on null', async () => {
    const hash = await credentials.hash('pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
    await service.login('  ALICE  ', 'pw');
    // Normalized (trim + lowercase) and queried as an OR over email/username.
    expect(findFirst).toHaveBeenCalledWith({
      where: { OR: [{ email: 'alice' }, { username: 'alice' }] },
    });
  });

  it('rejects a wrong password with a generic 401', async () => {
    const hash = await credentials.hash('right-pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
    await expect(
      service.login('alice@example.com', 'wrong-pw'),
    ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
  });

  it('unknown user and wrong password are INDISTINGUISHABLE (same 401, dummy-verify runs)', async () => {
    const verifySpy = jest.spyOn(credentials, 'verify');

    // Unknown user: findFirst returns null; a dummy verify must still run (constant-time).
    findFirst.mockResolvedValue(null);
    await expect(service.login('ghost@example.com', 'pw')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
    expect(verifySpy).toHaveBeenLastCalledWith(null, 'pw');

    // Wrong password on a known user: same exception type + message.
    const hash = await credentials.hash('right');
    findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
    await expect(service.login('alice@example.com', 'nope')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
  });

  it('FAILS CLOSED on a null passwordHash — never authenticates, even with an empty password', async () => {
    findFirst.mockResolvedValue(makeUser({ passwordHash: null }));
    await expect(service.login('alice@example.com', '')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      service.login('alice@example.com', 'anything'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a directoryOnly user even with a correct password', async () => {
    const hash = await credentials.hash('pw');
    findFirst.mockResolvedValue(
      makeUser({ passwordHash: hash, directoryOnly: true }),
    );
    await expect(service.login('alice@example.com', 'pw')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
  });

  it('rejects an inactive user even with a correct password', async () => {
    const hash = await credentials.hash('pw');
    findFirst.mockResolvedValue(
      makeUser({ passwordHash: hash, isActive: false }),
    );
    await expect(service.login('alice@example.com', 'pw')).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
  });

  it('treats a soft-deleted user (live-filtered → null) as an unknown user', async () => {
    // The live client returns null for soft-deleted rows; that is the unknown-user path (fail closed).
    findFirst.mockResolvedValue(null);
    await expect(service.login('alice@example.com', 'pw')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rehashes on login when the stored hash is below the target params', async () => {
    const weak = await weakHash('pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: weak }));

    await service.login('alice@example.com', 'pw');
    expect(update).toHaveBeenCalledTimes(1);
    const [arg] = update.mock.calls[0] as [
      { where: { id: string }; data: { passwordHash: string } },
    ];
    expect(arg.where).toEqual({ id: VALID_ID });
    expect(arg.data.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(arg.data.passwordHash).toContain('m=19456,t=2,p=1');
  });

  it('does NOT rehash when the stored hash already meets the target', async () => {
    const hash = await credentials.hash('pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
    await service.login('alice@example.com', 'pw');
    expect(update).not.toHaveBeenCalled();
  });

  it('a failed rehash never blocks a valid login (best-effort)', async () => {
    const weak = await weakHash('pw');
    findFirst.mockResolvedValue(makeUser({ passwordHash: weak }));
    update.mockRejectedValue(new Error('db down'));
    const res = await service.login('alice@example.com', 'pw');
    expect(typeof res.token).toBe('string');
  });

  describe('per-account exponential backoff', () => {
    it('backs off a known account after repeated failures (still a generic 401)', async () => {
      const hash = await credentials.hash('right');
      findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));

      const verifySpy = jest.spyOn(credentials, 'verify');
      // 6 wrong attempts (threshold is 5): the 6th pushes lockedUntil into the future.
      for (let i = 0; i < 6; i++) {
        await expect(
          service.login('alice@example.com', 'wrong'),
        ).rejects.toThrow(UnauthorizedException);
      }
      verifySpy.mockClear();

      // Now locked: even the CORRECT password is rejected with the same generic 401 while backed off.
      await expect(service.login('alice@example.com', 'right')).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
      // A verify still ran on the locked path (uniform timing) — against the dummy (null), not the row.
      expect(verifySpy).toHaveBeenCalledWith(null, 'right');
    });

    it('does not lock unknown identifiers (no enumeration via lockout)', async () => {
      findFirst.mockResolvedValue(null);
      // Many failures against unknown identifiers never create a lock (nothing to key on).
      for (let i = 0; i < 20; i++) {
        await expect(service.login('ghost@example.com', 'x')).rejects.toThrow(
          UnauthorizedException,
        );
      }
      // A subsequently-known user with the right password still logs in (the map was never populated
      // for a real account by the unknown attempts).
      const hash = await credentials.hash('pw');
      findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
      const res = await service.login('alice@example.com', 'pw');
      expect(typeof res.token).toBe('string');
    });

    it('clears the backoff counter on a successful login', async () => {
      const hash = await credentials.hash('right');
      findFirst.mockResolvedValue(makeUser({ passwordHash: hash }));
      // A few failures (below the lock threshold), then a success clears the counter.
      for (let i = 0; i < 3; i++) {
        await expect(
          service.login('alice@example.com', 'wrong'),
        ).rejects.toThrow(UnauthorizedException);
      }
      const res = await service.login('alice@example.com', 'right');
      expect(typeof res.token).toBe('string');
    });
  });
});
