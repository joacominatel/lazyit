import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

// Keep the real generated Prisma client out of this unit test (PrismaService pulls it in at module load).
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

// Mock the SMTP mailer so no real nodemailer transport is built; we assert the render/send were reached.
const sendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../smtp/email.mailer', () => ({
  buildTransport: jest.fn(() => ({ sendMail })),
  formatFrom: jest.fn(() => ({ address: 'noreply@lazyit.local' })),
  renderPasswordResetEmail: jest.fn(() => ({
    subject: 'Reset your lazyit password',
    text: 'reset',
    html: '<a>reset</a>',
  })),
}));

import { renderPasswordResetEmail } from '../../smtp/email.mailer';
import { PasswordLifecycleService } from './password-lifecycle.service';
import { LocalCredentialService } from './local-credential.service';
import { hashResetToken } from './password-reset-token';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

interface UserRow {
  id: string;
  email: string;
  username: string | null;
  isActive: boolean;
  directoryOnly: boolean;
  passwordHash: string | null;
  sessionEpoch: number;
  mustChangePassword: boolean;
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: VALID_ID,
    email: 'alice@example.com',
    username: 'alice',
    isActive: true,
    directoryOnly: false,
    passwordHash: null,
    sessionEpoch: 0,
    mustChangePassword: false,
    ...overrides,
  };
}

interface TokenRow {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * PasswordLifecycleService unit tests (ADR-0086 §F4, F4a) — REAL LocalCredentialService (real argon2, so
 * the constant-time / fail-closed verify is genuinely exercised) with a MOCKED Prisma + SMTP + history.
 * Security-graded coverage: change verifies the current password + bumps epoch + clears the flag; forgot
 * is enumeration-safe + hashes the token at rest + TTL + per-account cap + uniform when SMTP is off; reset
 * is single-use + expiry + epoch-bump + sibling-invalidation + generic-error; SA/OIDC modes fail closed.
 */
describe('PasswordLifecycleService (ADR-0086 §F4)', () => {
  let credentials: LocalCredentialService;
  let userFindFirst: jest.Mock;
  let userUpdate: jest.Mock;
  let tokDeleteMany: jest.Mock;
  let tokCount: jest.Mock;
  let tokCreate: jest.Mock;
  let tokFindFirst: jest.Mock;
  let txTokUpdateMany: jest.Mock;
  let txTokDeleteMany: jest.Mock;
  let txUserUpdate: jest.Mock;
  let historyRecord: jest.Mock;
  let resolveConfig: jest.Mock;
  let prisma: Record<string, unknown>;
  let service: PasswordLifecycleService;

  beforeAll(() => {
    process.env.SESSION_SIGNING_SECRET =
      'test-session-signing-secret-0123456789abcdef';
  });

  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    delete process.env.WEB_ORIGIN;
    sendMail.mockClear();
    (renderPasswordResetEmail as jest.Mock).mockClear();

    credentials = new LocalCredentialService();
    userFindFirst = jest.fn();
    userUpdate = jest.fn().mockResolvedValue({ id: VALID_ID, sessionEpoch: 1 });
    tokDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    tokCount = jest.fn().mockResolvedValue(0);
    tokCreate = jest.fn().mockResolvedValue({});
    tokFindFirst = jest.fn();
    txTokUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txTokDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    // tx.user.update returns the fresh row (changePassword mints a token off the new epoch).
    txUserUpdate = jest
      .fn()
      .mockResolvedValue({ id: VALID_ID, sessionEpoch: 1 });
    historyRecord = jest.fn().mockResolvedValue({});
    resolveConfig = jest.fn().mockResolvedValue(null); // SMTP off by default

    prisma = {
      user: { findFirst: userFindFirst, update: userUpdate },
      passwordResetToken: {
        deleteMany: tokDeleteMany,
        count: tokCount,
        create: tokCreate,
        findFirst: tokFindFirst,
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          passwordResetToken: {
            updateMany: txTokUpdateMany,
            deleteMany: txTokDeleteMany,
          },
          user: { update: txUserUpdate },
        }),
      ),
    };

    service = new PasswordLifecycleService(
      prisma as never,
      credentials,
      { record: historyRecord } as never,
      { resolveConfig } as never,
    );
  });

  // ---------- 1. change-password -------------------------------------------

  describe('changePassword', () => {
    it('verifies the current password, bumps the epoch, clears the flag, and returns a fresh token', async () => {
      const hash = await credentials.hash('old-pw-123');
      const user = makeUser({ passwordHash: hash, mustChangePassword: true });

      const res = await service.changePassword(
        user as never,
        'old-pw-123',
        'NewPass1!',
      );

      // The stored write (inside the tx): a NEW hash, epoch increment, flag cleared, timestamp set.
      expect(txUserUpdate).toHaveBeenCalledTimes(1);
      const data = firstArg<UpdateArg>(txUserUpdate).data;
      expect(data.sessionEpoch).toEqual({ increment: 1 });
      expect(data.mustChangePassword).toBe(false);
      expect(typeof data.passwordHash).toBe('string');
      expect(data.passwordHash).not.toBe(hash); // genuinely rehashed
      expect(data.passwordUpdatedAt).toBeInstanceOf(Date);
      // The new password actually verifies against the freshly-stored hash.
      await expect(
        credentials.verify(data.passwordHash, 'NewPass1!'),
      ).resolves.toMatchObject({ valid: true });

      // F-3: outstanding (unused) reset tokens are swept in the SAME tx so a live emailed link is dead.
      expect(txTokDeleteMany).toHaveBeenCalledWith({
        where: { userId: VALID_ID, usedAt: null },
      });

      // Audited append-only as a self-action, on the tx client (atomic with the write).
      expect(historyRecord).toHaveBeenCalledWith(expect.anything(), {
        userId: VALID_ID,
        eventType: 'PASSWORD_CHANGED',
        actor: { userId: VALID_ID },
      });

      // A fresh token minted at the NEW epoch (1) so the caller stays logged in.
      await expect(credentials.verifySession(res.token)).resolves.toEqual({
        sub: VALID_ID,
        epoch: 1,
      });
    });

    it('rejects a wrong current password with a generic 401 and writes nothing', async () => {
      const hash = await credentials.hash('right-pw');
      const user = makeUser({ passwordHash: hash });
      await expect(
        service.changePassword(user as never, 'wrong-pw', 'NewPass1!'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(txUserUpdate).not.toHaveBeenCalled();
      expect(historyRecord).not.toHaveBeenCalled();
    });

    it('F-2: rejects a new password identical to the current one (defeats forced-rotation bypass)', async () => {
      const hash = await credentials.hash('Samepass1!');
      const user = makeUser({ passwordHash: hash, mustChangePassword: true });
      // Current verifies, but new === current → 400, and NOTHING is written (flag stays set).
      await expect(
        service.changePassword(user as never, 'Samepass1!', 'Samepass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
      expect(txUserUpdate).not.toHaveBeenCalled();
      expect(historyRecord).not.toHaveBeenCalled();
    });

    it('fails closed for a user with no local password (null hash → generic 401)', async () => {
      const user = makeUser({ passwordHash: null });
      await expect(
        service.changePassword(user as never, 'anything', 'NewPass1!'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(txUserUpdate).not.toHaveBeenCalled();
    });

    it('refuses a directory-only person', async () => {
      const user = makeUser({ directoryOnly: true, passwordHash: 'x' });
      await expect(
        service.changePassword(user as never, 'old', 'NewPass1!'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is not available outside local mode (OIDC)', async () => {
      process.env.AUTH_MODE = 'oidc';
      const hash = await credentials.hash('old-pw');
      const user = makeUser({ passwordHash: hash });
      await expect(
        service.changePassword(user as never, 'old-pw', 'NewPass1!'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txUserUpdate).not.toHaveBeenCalled();
    });
  });

  // ---------- 3. forgot-password (enumeration-safe) ------------------------

  describe('forgotPassword', () => {
    it('creates a HASHED single-use token (≤1h TTL) for a known user; raw is never stored', async () => {
      userFindFirst.mockResolvedValue(makeUser());
      const before = Date.now();
      await service.forgotPassword('alice@example.com');

      expect(tokCreate).toHaveBeenCalledTimes(1);
      const data = firstArg<CreateTokenArg>(tokCreate).data;
      // Stored value is a SHA-256 hex digest (hash-at-rest), NOT a raw token.
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.userId).toBe(VALID_ID);
      // TTL is within (0, 1h].
      const ttl = data.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 50);
      // No plaintext token field leaked into the row.
      expect(Object.keys(data)).not.toContain('token');
      expect(Object.keys(data)).not.toContain('raw');
    });

    it('is enumeration-safe: an UNKNOWN identifier creates no token and does not throw', async () => {
      userFindFirst.mockResolvedValue(null);
      await expect(
        service.forgotPassword('nobody@example.com'),
      ).resolves.toBeUndefined();
      expect(tokCreate).not.toHaveBeenCalled();
    });

    it('a known and an unknown identifier are INDISTINGUISHABLE at the boundary (both resolve void)', async () => {
      userFindFirst.mockResolvedValueOnce(makeUser());
      const known = await service.forgotPassword('alice@example.com');
      userFindFirst.mockResolvedValueOnce(null);
      const unknown = await service.forgotPassword('ghost@example.com');
      expect(known).toBeUndefined();
      expect(unknown).toBeUndefined();
    });

    it('skips inactive and directory-only users silently (still uniform, no token)', async () => {
      userFindFirst.mockResolvedValue(makeUser({ isActive: false }));
      await service.forgotPassword('alice@example.com');
      userFindFirst.mockResolvedValue(makeUser({ directoryOnly: true }));
      await service.forgotPassword('alice@example.com');
      expect(tokCreate).not.toHaveBeenCalled();
    });

    it('enforces the per-account outstanding-token cap (over cap → no new token, still uniform)', async () => {
      userFindFirst.mockResolvedValue(makeUser());
      tokCount.mockResolvedValue(3); // at MAX_ACTIVE_TOKENS_PER_USER
      await expect(
        service.forgotPassword('alice@example.com'),
      ).resolves.toBeUndefined();
      expect(tokCreate).not.toHaveBeenCalled();
    });

    it('when SMTP is NOT configured, still creates the token and returns uniformly (no email, no throw)', async () => {
      userFindFirst.mockResolvedValue(makeUser());
      resolveConfig.mockResolvedValue(null);
      await service.forgotPassword('alice@example.com');
      await flush();
      expect(tokCreate).toHaveBeenCalledTimes(1);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('when SMTP IS configured + WEB_ORIGIN set, emails a link to the resolved user', async () => {
      process.env.WEB_ORIGIN = 'https://lazyit.example.com';
      userFindFirst.mockResolvedValue(makeUser());
      resolveConfig.mockResolvedValue({ fromAddress: 'noreply@lazyit.local' });
      await service.forgotPassword('alice@example.com');
      await flush();
      expect(renderPasswordResetEmail).toHaveBeenCalledTimes(1);
      const arg = firstArg<{ resetUrl: string }>(
        renderPasswordResetEmail as jest.Mock,
      );
      expect(arg.resetUrl).toMatch(
        /^https:\/\/lazyit\.example\.com\/reset-password\?token=/,
      );
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(firstArg<{ to: string }>(sendMail).to).toBe('alice@example.com');
    });

    it('does nothing (and never throws) outside local mode', async () => {
      process.env.AUTH_MODE = 'oidc';
      await expect(
        service.forgotPassword('alice@example.com'),
      ).resolves.toBeUndefined();
      expect(userFindFirst).not.toHaveBeenCalled();
      expect(tokCreate).not.toHaveBeenCalled();
    });
  });

  // ---------- 4. reset-password (single-use / TTL / generic error) --------

  function makeToken(overrides: Partial<TokenRow> = {}): TokenRow {
    return {
      id: 'tok_1',
      tokenHash: hashResetToken('raw-token-abc'),
      userId: VALID_ID,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      usedAt: null,
      ...overrides,
    };
  }

  describe('resetPassword', () => {
    it('consumes a valid token: sets the new password, bumps epoch, clears the flag, invalidates siblings, audits', async () => {
      tokFindFirst.mockResolvedValue(makeToken());
      userFindFirst.mockResolvedValue(makeUser());

      await service.resetPassword('raw-token-abc', 'NewPass1!');

      // Looked up by the HASH of the presented token (never the raw value).
      expect(tokFindFirst).toHaveBeenCalledWith({
        where: { tokenHash: hashResetToken('raw-token-abc') },
      });
      // Consume THIS token (guarded by usedAt: null) then invalidate siblings — two updateMany calls.
      expect(txTokUpdateMany).toHaveBeenCalledTimes(2);
      const consumeWhere = firstArg<WhereArg>(txTokUpdateMany, 0).where;
      expect(consumeWhere).toMatchObject({ id: 'tok_1', usedAt: null });
      const siblingsWhere = firstArg<WhereArg>(txTokUpdateMany, 1).where;
      expect(siblingsWhere).toMatchObject({
        userId: VALID_ID,
        usedAt: null,
        id: { not: 'tok_1' },
      });
      // The credential write: new hash, epoch increment, flag cleared.
      const data = firstArg<UpdateArg>(txUserUpdate).data;
      expect(data.sessionEpoch).toEqual({ increment: 1 });
      expect(data.mustChangePassword).toBe(false);
      await expect(
        credentials.verify(data.passwordHash, 'NewPass1!'),
      ).resolves.toMatchObject({ valid: true });
      // Self-service audit.
      expect(historyRecord).toHaveBeenCalledWith(expect.anything(), {
        userId: VALID_ID,
        eventType: 'PASSWORD_RESET_COMPLETED',
        actor: { userId: VALID_ID },
      });
    });

    it('an UNKNOWN token yields the generic error (no oracle)', async () => {
      tokFindFirst.mockResolvedValue(null);
      await expect(
        service.resetPassword('does-not-exist', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txUserUpdate).not.toHaveBeenCalled();
    });

    it('an ALREADY-USED token yields the generic error (single-use)', async () => {
      tokFindFirst.mockResolvedValue(makeToken({ usedAt: new Date() }));
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
    });

    it('an EXPIRED token yields the generic error (TTL)', async () => {
      tokFindFirst.mockResolvedValue(
        makeToken({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a token for an INELIGIBLE user (inactive) yields the generic error', async () => {
      tokFindFirst.mockResolvedValue(makeToken());
      userFindFirst.mockResolvedValue(makeUser({ isActive: false }));
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a token whose user is soft-deleted (live-filtered → null) yields the generic error', async () => {
      tokFindFirst.mockResolvedValue(makeToken());
      userFindFirst.mockResolvedValue(null);
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is race-safe: a concurrently-consumed token (updateMany count 0) rolls back with the generic error', async () => {
      tokFindFirst.mockResolvedValue(makeToken());
      userFindFirst.mockResolvedValue(makeUser());
      txTokUpdateMany.mockResolvedValueOnce({ count: 0 }); // lost the consume race
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fails closed outside local mode (generic error, no lookup)', async () => {
      process.env.AUTH_MODE = 'oidc';
      await expect(
        service.resetPassword('raw-token-abc', 'NewPass1!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tokFindFirst).not.toHaveBeenCalled();
    });
  });
});

/** Flush the microtask/immediate queue so a fire-and-forget email send completes before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Typed accessor for a mock's first call's first argument (keeps the spec free of unsafe-any drilling). */
function firstArg<T>(m: jest.Mock, call = 0): T {
  const calls = m.mock.calls as unknown[][];
  return calls[call][0] as T;
}

interface UpdateArg {
  data: {
    sessionEpoch: unknown;
    mustChangePassword: boolean;
    passwordHash: string;
    passwordUpdatedAt?: Date;
  };
}
interface CreateTokenArg {
  data: { tokenHash: string; userId: string; expiresAt: Date };
}
interface WhereArg {
  where: Record<string, unknown>;
}
