/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- test wiring over an untyped in-memory fake */
// The generated client never loads under Jest (no DB); the services run over FakeOAuthPrisma instead.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  CLAUDE_CODE_REDIRECT,
  RESOURCE,
  authorize,
  buildHarness,
  enableMcp,
  human,
  pkcePair,
  registerClient,
  seedUser,
  useHttpsInstance,
  type Harness,
} from '../../test/oauth/oauth-harness';
import { fakeCuid } from '../../test/oauth/fake-oauth-prisma';
import {
  AUTHORIZATION_CODE_RETENTION_MS,
  AUTHORIZATION_CODE_TTL_MS,
  DCR_MAX_PENDING_REGISTRATIONS,
} from './oauth.constants';
import { OAuthSweeper } from './oauth.sweeper';
import { OAuthAuthorizeRefusedException } from './authorization.service';

/**
 * The OAuth/MCP limits unit (#1683, split from #1344): DCR evicts the oldest unused pending registration
 * at the cap, the authorization code carries the credential epoch seen at consent, and a replayed code
 * revokes the grant it produced.
 */

const ENV_KEYS = ['WEB_ORIGIN', 'AUTH_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};

let h: Harness;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  useHttpsInstance();
  h = buildHarness();
  enableMcp(h);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.useRealTimers();
});

async function oauthError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return (err as { getResponse?: () => unknown }).getResponse?.() ?? err;
  }
  throw new Error('expected an OAuth error');
}

/* ── DCR: evict the oldest unused pending registration at the cap ──────────────────────────────────── */

describe('DCR at the pending-registration cap (#1683)', () => {
  /** Fill the cap with unused DCR rows, oldest first (one minute apart, all inside the 24 h window). */
  function fillPending(count = DCR_MAX_PENDING_REGISTRATIONS): any[] {
    const start = Date.now() - 12 * 60 * 60 * 1000;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: fakeCuid(),
      clientId: `lzc_pending_${i}`,
      kind: 'dcr',
      name: `Pending ${i}`,
      clientUri: null,
      logoUri: null,
      redirectUris: ['http://localhost:53682/callback'],
      metadata: {},
      lastUsedAt: null,
      fetchedAt: null,
      createdAt: new Date(start + i * 60_000),
      updatedAt: new Date(start + i * 60_000),
    }));
    h.prisma.tables.oAuthClient.push(...rows);
    return rows;
  }

  const clientIds = () =>
    h.prisma.tables.oAuthClient.map((row) => row.clientId as string);

  it('evicts the oldest unused registration instead of refusing the new one', async () => {
    const rows = fillPending();
    const clientId = await registerClient(h);
    expect(clientIds()).not.toContain(rows[0].clientId);
    expect(clientIds()).toContain(rows[1].clientId);
    expect(clientIds()).toContain(clientId);
    expect(h.prisma.tables.oAuthClient).toHaveLength(
      DCR_MAX_PENDING_REGISTRATIONS,
    );
  });

  it('never evicts a registration with a grant or a pending authorization code', async () => {
    const rows = fillPending();
    // The oldest got a grant; the next one is mid-consent (an authorization code exists).
    h.prisma.tables.oAuthGrant.push({
      id: fakeCuid(),
      clientRefId: rows[0].id,
      deletedAt: null,
    });
    h.prisma.tables.oAuthAuthorizationCode.push({
      id: fakeCuid(),
      clientRefId: rows[1].id,
      usedAt: null,
    });
    await registerClient(h);
    expect(clientIds()).toContain(rows[0].clientId);
    expect(clientIds()).toContain(rows[1].clientId);
    expect(clientIds()).not.toContain(rows[2].clientId);
  });

  it('refuses with 429 only when no pending registration is evictable', async () => {
    const rows = fillPending();
    for (const row of rows) {
      h.prisma.tables.oAuthAuthorizationCode.push({
        id: fakeCuid(),
        clientRefId: row.id,
        usedAt: null,
      });
    }
    expect(await oauthError(registerClient(h))).toMatchObject({
      error: 'temporarily_unavailable',
    });
    expect(h.prisma.tables.oAuthClient).toHaveLength(
      DCR_MAX_PENDING_REGISTRATIONS,
    );
  });

  it('evicts nothing below the cap', async () => {
    const rows = fillPending(DCR_MAX_PENDING_REGISTRATIONS - 1);
    await registerClient(h);
    expect(clientIds()).toContain(rows[0].clientId);
    expect(h.prisma.tables.oAuthClient).toHaveLength(
      DCR_MAX_PENDING_REGISTRATIONS,
    );
  });
});

describe('consent racing an eviction (#1683 review)', () => {
  function approve(user: any, clientId: string) {
    return h.authorization.decision(human(user), {
      params: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CODE_REDIRECT,
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        state: 'st',
        scope: 'lazyit.read lazyit.write',
        resource: RESOURCE,
      },
      decision: 'approve',
      scopes: ['lazyit.read'],
    });
  }

  it('answers INVALID_CLIENT (not a 500) when the client was evicted before the code insert (P2003)', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    h.prisma.oAuthAuthorizationCode.create.mockRejectedValueOnce(
      Object.assign(new Error('Foreign key constraint violated'), {
        code: 'P2003',
      }),
    );
    await expect(approve(user, clientId)).rejects.toBeInstanceOf(
      OAuthAuthorizeRefusedException,
    );
    h.prisma.oAuthAuthorizationCode.create.mockRejectedValueOnce(
      Object.assign(new Error('Foreign key constraint violated'), {
        code: 'P2003',
      }),
    );
    await expect(approve(user, clientId)).rejects.toMatchObject({
      refusal: 'INVALID_CLIENT',
    });
    expect(h.prisma.tables.oAuthAuthorizationCode).toHaveLength(0);
  });

  it('lets any other insert failure propagate', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    h.prisma.oAuthAuthorizationCode.create.mockRejectedValueOnce(
      new Error('connection reset'),
    );
    await expect(approve(user, clientId)).rejects.toThrow('connection reset');
  });
});

/* ── the credential epoch on the authorization code ────────────────────────────────────────────────── */

describe('the authorization code carries the credential epoch seen at consent (#1683)', () => {
  async function exchange(
    clientId: string,
    issued: { code: string; verifier: string; redirectUri: string },
  ) {
    return h.tokens.exchangeAuthorizationCode({
      grant_type: 'authorization_code',
      code: issued.code,
      code_verifier: issued.verifier,
      client_id: clientId,
      redirect_uri: issued.redirectUri,
      resource: RESOURCE,
    });
  }

  it('stores the epoch on the code', async () => {
    const user = seedUser(h, { mcpCredentialEpoch: 4 });
    const clientId = await registerClient(h);
    await authorize(h, user, { clientId });
    expect(h.prisma.tables.oAuthAuthorizationCode[0].mcpCredentialEpoch).toBe(
      4,
    );
  });

  it('refuses the exchange when the epoch moved between consent and exchange', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const issued = await authorize(h, user, { clientId });
    // A password change (or reset, deactivation, "revoke sessions") inside the code's 60 s.
    user.mcpCredentialEpoch += 1;
    expect(await oauthError(exchange(clientId, issued))).toMatchObject({
      error: 'invalid_grant',
    });
    expect(h.prisma.tables.oAuthGrant).toHaveLength(0);
  });

  it('keeps a code issued before the column (null epoch) working until it expires', async () => {
    const user = seedUser(h, { mcpCredentialEpoch: 2 });
    const clientId = await registerClient(h);
    const issued = await authorize(h, user, { clientId });
    h.prisma.tables.oAuthAuthorizationCode[0].mcpCredentialEpoch = null;
    await expect(exchange(clientId, issued)).resolves.toMatchObject({
      token_type: 'Bearer',
    });
    expect(h.prisma.tables.oAuthGrant[0].mcpCredentialEpoch).toBe(2);
  });
});

/* ── code → grant link, and a replayed code revokes its grant ─────────────────────────────────────── */

describe('a replayed authorization code revokes the grant it produced (#1683)', () => {
  async function connectWithCode() {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const issued = await authorize(h, user, { clientId });
    const request = {
      grant_type: 'authorization_code',
      code: issued.code,
      code_verifier: issued.verifier,
      client_id: clientId,
      redirect_uri: issued.redirectUri,
      resource: RESOURCE,
    };
    const tokens = await h.tokens.exchangeAuthorizationCode(request);
    return { user, clientId, request, tokens };
  }

  it('links the code to the grant it produced', async () => {
    await connectWithCode();
    const [grant] = h.prisma.tables.oAuthGrant;
    expect(h.prisma.tables.oAuthAuthorizationCode[0].grantId).toBe(grant.id);
  });

  it('a valid replay is refused and revokes the grant, audited CODE_REUSE_DETECTED', async () => {
    const { user, request, tokens } = await connectWithCode();
    expect(
      await oauthError(h.tokens.exchangeAuthorizationCode(request)),
    ).toMatchObject({ error: 'invalid_grant' });
    const [grant] = h.prisma.tables.oAuthGrant;
    expect(grant).toMatchObject({ revokeReason: 'code_replay' });
    expect(grant.deletedAt).toBeInstanceOf(Date);
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'invalid' },
    );
    const actions = h.prisma.tables.oAuthAuditLog.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['CODE_REUSE_DETECTED', 'GRANT_REVOKED']),
    );
    expect(
      h.prisma.tables.oAuthAuditLog.find(
        (row) => row.action === 'CODE_REUSE_DETECTED',
      ),
    ).toMatchObject({ userId: user.id, grantId: grant.id });
  });

  it.each([
    ['a wrong PKCE verifier', { code_verifier: 'x'.repeat(43) }],
    ['another client', { client_id: 'lzc_someone_else' }],
    ['another redirect', { redirect_uri: 'http://localhost:1/other' }],
  ])(
    'an invalid replay (%s) is refused but revokes nothing (no denial of service)',
    async (_label, override) => {
      const { request } = await connectWithCode();
      expect(
        await oauthError(
          h.tokens.exchangeAuthorizationCode({ ...request, ...override }),
        ),
      ).toMatchObject({ error: 'invalid_grant' });
      expect(h.prisma.tables.oAuthGrant[0].deletedAt).toBeNull();
    },
  );

  it('a replay after the code expired still revokes, while the row is retained', async () => {
    const { request } = await connectWithCode();
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(Date.now() + AUTHORIZATION_CODE_TTL_MS + 60_000);
    await oauthError(h.tokens.exchangeAuthorizationCode(request));
    expect(h.prisma.tables.oAuthGrant[0].revokeReason).toBe('code_replay');
  });

  it('a code issued before the link (no grantId) is only refused', async () => {
    const { request } = await connectWithCode();
    h.prisma.tables.oAuthAuthorizationCode[0].grantId = null;
    expect(
      await oauthError(h.tokens.exchangeAuthorizationCode(request)),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(h.prisma.tables.oAuthGrant[0].deletedAt).toBeNull();
  });

  it('the sweeper keeps a redeemed code for its retention window, then collects it', async () => {
    await connectWithCode();
    const sweeper = new OAuthSweeper(h.prisma as never);
    const code = h.prisma.tables.oAuthAuthorizationCode[0];
    const expiry = (code.expiresAt as Date).getTime();
    expect(
      (await sweeper.sweep(new Date(expiry + AUTHORIZATION_CODE_RETENTION_MS)))
        .codes,
    ).toBe(0);
    expect(
      (
        await sweeper.sweep(
          new Date(expiry + AUTHORIZATION_CODE_RETENTION_MS + 1000),
        )
      ).codes,
    ).toBe(1);
  });
});
