import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// Keep the real generated Prisma client and ESM-only jose out of this test: every service here runs
// against the in-memory user row and session table below, with real HS256 tokens.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { JwtAuthGuard } from '../jwt-auth.guard';
import { LocalCredentialService } from './local-credential.service';
import { LoginService } from './login.service';
import { UserSessionsService } from './user-sessions.service';
import { UserSessionSweeper } from './user-session.sweeper';
import { MAX_SESSIONS_PER_USER, UserSessionStore } from './user-session.store';
import {
  inMemoryUserSessions,
  type SessionRow,
} from './user-session-table.harness-spec';

/**
 * Per-device sessions end to end (issue #1420, ADR-0086 §9): the REAL LoginService, JwtAuthGuard,
 * UserSessionsService and UserSessionSweeper over one in-memory user row and an in-memory session table,
 * with real HS256 tokens. Proves the CEO's decisions: a sign-in records the device, one session can be
 * ended without touching the others, a pre-upgrade token keeps working, sign-out everywhere ends them all,
 * and dead rows are purged.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'Old-password-1!';
const FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('per-device sessions (#1420, ADR-0086 §9)', () => {
  const originalMode = process.env.AUTH_MODE;
  let row: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
    role: string;
    isActive: boolean;
    directoryOnly: boolean;
    passwordHash: string | null;
    sessionEpoch: number;
    deletedAt: Date | null;
  };
  let table: Map<string, SessionRow>;
  let historyRecord: jest.Mock;
  let prisma: Record<string, unknown>;
  let credentials: LocalCredentialService;
  let login: LoginService;
  let sessions: UserSessionsService;
  let guard: JwtAuthGuard;
  let sweeper: UserSessionSweeper;

  beforeAll(() => {
    process.env.SESSION_SIGNING_SECRET =
      'test-session-signing-secret-0123456789abcdef';
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(async () => {
    process.env.AUTH_MODE = 'local';
    credentials = new LocalCredentialService();
    row = {
      id: USER_ID,
      email: 'alice@example.com',
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Smith',
      role: 'MEMBER',
      isActive: true,
      directoryOnly: false,
      passwordHash: await credentials.hash(PASSWORD),
      sessionEpoch: 0,
      deletedAt: null,
    };
    const userSessions = inMemoryUserSessions();
    table = userSessions.rows;
    historyRecord = jest.fn().mockResolvedValue({});

    type Where = {
      id?: string;
      sessionEpoch?: number;
      OR?: Array<{ email?: string; username?: string }>;
    };
    const matches = (where: Where) =>
      row.deletedAt === null &&
      (where.id === undefined || where.id === row.id) &&
      (where.sessionEpoch === undefined ||
        where.sessionEpoch === row.sessionEpoch) &&
      (where.OR === undefined ||
        where.OR.some(
          (c) => c.email === row.email || c.username === row.username,
        ));

    prisma = {
      user: {
        findFirst: jest.fn(({ where }: { where: Where }) =>
          Promise.resolve(matches(where) ? { ...row } : null),
        ),
        update: jest.fn(),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: Where;
            data: { sessionEpoch: { increment: number } };
          }) => {
            if (!matches(where)) return Promise.resolve({ count: 0 });
            row.sessionEpoch += data.sessionEpoch.increment;
            return Promise.resolve({ count: 1 });
          },
        ),
      },
      userSession: userSessions.delegate,
      // The sweeper's stale-epoch purge is a fixed raw statement; model its effect on the table.
      $executeRaw: jest.fn(() => {
        let count = 0;
        for (const session of [...table.values()]) {
          if (session.userId === row.id && session.epoch !== row.sessionEpoch) {
            table.delete(session.id);
            count += 1;
          }
        }
        return Promise.resolve(count);
      }),
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn(prisma)),
    );

    const store = new UserSessionStore(prisma as never);
    login = new LoginService(prisma as never, credentials, store);
    sessions = new UserSessionsService(
      prisma as never,
      { record: historyRecord } as never,
      store,
    );
    guard = new JwtAuthGuard(
      prisma as never,
      new Reflector(),
      credentials,
      undefined,
      undefined,
      store,
    );
    sweeper = new UserSessionSweeper(prisma as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function authenticate(token: string) {
    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as never;
    await guard.canActivate(ctx);
    return req as {
      user: typeof row;
      localSession: { rememberMe: boolean; sessionId: string | null };
    };
  }

  function signIn(userAgent: string, ip: string, rememberMe = false) {
    return login.login('alice', PASSWORD, rememberMe, { userAgent, ip });
  }

  it('a sign-in records the device: user agent, IP, dates, remember-me', async () => {
    const res = await signIn(FIREFOX, '203.0.113.7');
    expect(table.size).toBe(1);
    const [session] = [...table.values()];
    expect(session).toMatchObject({
      userId: USER_ID,
      epoch: 0,
      userAgent: FIREFOX,
      ip: '203.0.113.7',
      rememberMe: false,
    });
    expect(session.expiresAt?.getTime()).toBe(res.expiresAt! * 1000);
    const req = await authenticate(res.token);
    expect(req.localSession.sessionId).toBe(session.id);
  });

  it('lists the live sessions with browser/OS parsed and the current one flagged', async () => {
    const laptop = await signIn(FIREFOX, '203.0.113.7');
    await signIn(SAFARI_IPHONE, '198.51.100.4', true);
    const req = await authenticate(laptop.token);

    const list = await sessions.list(
      req.user as never,
      req.localSession.sessionId,
    );

    expect(list.currentIsLegacy).toBe(false);
    expect(list.sessions).toHaveLength(2);
    const current = list.sessions.find((s) => s.current);
    expect(current).toMatchObject({
      browser: 'Firefox',
      os: 'Windows',
      ip: '203.0.113.7',
      rememberMe: false,
    });
    const phone = list.sessions.find((s) => !s.current);
    expect(phone).toMatchObject({
      browser: 'Safari',
      os: 'iOS',
      rememberMe: true,
      expiresAt: null,
    });
  });

  it('ending one session kills exactly that device; the others keep working', async () => {
    const laptop = await signIn(FIREFOX, '203.0.113.7');
    const phone = await signIn(SAFARI_IPHONE, '198.51.100.4');
    const onLaptop = await authenticate(laptop.token);
    const phoneSid = (await authenticate(phone.token)).localSession.sessionId!;

    await sessions.end(
      onLaptop.user as never,
      phoneSid,
      onLaptop.localSession.sessionId,
    );

    await expect(authenticate(phone.token)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(authenticate(laptop.token)).resolves.toBeDefined();
    expect(row.sessionEpoch).toBe(0);
    expect(historyRecord).toHaveBeenCalledWith(expect.anything(), {
      userId: USER_ID,
      eventType: 'SESSION_ENDED',
      payload: { sessionId: phoneSid, current: false },
      actor: { userId: USER_ID },
    });
  });

  it('ending the current session signs this device out', async () => {
    const laptop = await signIn(FIREFOX, '203.0.113.7');
    const req = await authenticate(laptop.token);
    await sessions.end(
      req.user as never,
      req.localSession.sessionId!,
      req.localSession.sessionId,
    );
    await expect(authenticate(laptop.token)).rejects.toThrow(
      'Session has been revoked',
    );
    expect(historyRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: { sessionId: req.localSession.sessionId, current: true },
      }),
    );
  });

  it("another user's session, an unknown id and a malformed id are all a 404, and nothing is ended", async () => {
    const laptop = await signIn(FIREFOX, '203.0.113.7');
    const req = await authenticate(laptop.token);
    const foreignId = '44444444-4444-4444-8444-444444444444';
    table.set(foreignId, {
      id: foreignId,
      userId: OTHER_USER_ID,
      epoch: 0,
      rememberMe: false,
      userAgent: null,
      ip: null,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: null,
    });

    for (const id of [
      foreignId,
      '55555555-5555-4555-8555-555555555555',
      'not-a-uuid',
    ]) {
      await expect(
        sessions.end(req.user as never, id, req.localSession.sessionId),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(table.has(foreignId)).toBe(true);
    expect(historyRecord).not.toHaveBeenCalled();
    await expect(authenticate(laptop.token)).resolves.toBeDefined();
  });

  it('a token issued before the upgrade (no sid) keeps working and is reported as legacy', async () => {
    const legacy = await credentials.mintSession(
      { id: USER_ID, sessionEpoch: 0 },
      { rememberMe: true },
    );
    const req = await authenticate(legacy.token);
    expect(req.localSession.sessionId).toBeNull();
    const list = await sessions.list(req.user as never, null);
    expect(list).toEqual({ sessions: [], currentIsLegacy: true });
  });

  it('sign out everywhere ends every session row and every token, legacy included', async () => {
    const legacy = await credentials.mintSession({
      id: USER_ID,
      sessionEpoch: 0,
    });
    const laptop = await signIn(FIREFOX, '203.0.113.7');
    const phone = await signIn(SAFARI_IPHONE, '198.51.100.4', true);
    const req = await authenticate(laptop.token);

    await login.logout(req.user as never);

    expect(table.size).toBe(0);
    for (const token of [legacy.token, laptop.token, phone.token]) {
      await expect(authenticate(token)).rejects.toThrow(UnauthorizedException);
    }
  });

  it('a session revoked by an epoch bump elsewhere drops out of the list and is purged by the sweeper', async () => {
    await signIn(FIREFOX, '203.0.113.7');
    // An admin reset / deactivation bumps the epoch without touching the session table.
    row.sessionEpoch += 1;
    const fresh = await signIn(SAFARI_IPHONE, '198.51.100.4');
    const req = await authenticate(fresh.token);

    const list = await sessions.list(
      req.user as never,
      req.localSession.sessionId,
    );
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].current).toBe(true);

    const swept = await sweeper.sweep();
    expect(swept).toEqual({ expired: 0, stale: 1, idle: 0 });
    expect(table.size).toBe(1);
  });

  it('an expired session is not listed and is purged by the sweeper', async () => {
    const res = await signIn(FIREFOX, '203.0.113.7');
    const later = new Date((res.expiresAt! + 60) * 1000);
    const req = await authenticate(res.token);

    const list = await sessions.list(req.user as never, null, later);
    expect(list.sessions).toHaveLength(0);

    const swept = await sweeper.sweep(later);
    expect(swept.expired).toBe(1);
    expect(table.size).toBe(0);
  });

  it('a remember-me session survives the sweeper while it is used within 400 days', async () => {
    await signIn(FIREFOX, '203.0.113.7', true);
    const swept = await sweeper.sweep(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    expect(swept).toEqual({ expired: 0, stale: 0, idle: 0 });
    expect(table.size).toBe(1);
  });

  it('a remember-me session idle for more than 400 days is purged', async () => {
    await signIn(FIREFOX, '203.0.113.7', true);
    await signIn(SAFARI_IPHONE, '198.51.100.4', true);
    const [idle] = [...table.values()];
    idle.lastSeenAt = new Date(Date.now() - 401 * 24 * 60 * 60 * 1000);

    const swept = await sweeper.sweep();

    expect(swept).toEqual({ expired: 0, stale: 0, idle: 1 });
    expect(table.has(idle.id)).toBe(false);
    expect(table.size).toBe(1);
  });

  it('a sign-in beyond 50 sessions evicts the least recently active ones', async () => {
    const base = Date.now() - 1000 * 60 * 60;
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      table.set(id, {
        id,
        userId: USER_ID,
        epoch: 0,
        rememberMe: true,
        userAgent: null,
        ip: null,
        createdAt: new Date(base),
        // Row 0 is the least recently active.
        lastSeenAt: new Date(base + i * 1000),
        expiresAt: null,
      });
    }
    const oldest = '00000000-0000-4000-8000-000000000000';
    const foreign = '66666666-6666-4666-8666-666666666666';
    table.set(foreign, {
      ...table.get(oldest)!,
      id: foreign,
      userId: OTHER_USER_ID,
    });

    const res = await signIn(FIREFOX, '203.0.113.7');

    const mine = [...table.values()].filter((s) => s.userId === USER_ID);
    expect(mine).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(table.has(oldest)).toBe(false);
    // Another user's rows are never counted or evicted.
    expect(table.has(foreign)).toBe(true);
    // The new session is kept and authenticates.
    await expect(authenticate(res.token)).resolves.toBeDefined();
  });

  it('outside local mode the list is empty', async () => {
    const res = await signIn(FIREFOX, '203.0.113.7');
    const req = await authenticate(res.token);
    process.env.AUTH_MODE = 'oidc';
    await expect(
      sessions.list(req.user as never, req.localSession.sessionId),
    ).resolves.toEqual({ sessions: [], currentIsLegacy: false });
  });
});
