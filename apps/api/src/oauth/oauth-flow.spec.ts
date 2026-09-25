/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// The generated client never loads under Jest (no DB); the services run over FakeOAuthPrisma instead.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { NotFoundException } from '@nestjs/common';
import {
  CLAUDE_CODE_REDIRECT,
  ISSUER,
  PASSWORD,
  RESOURCE,
  authorize,
  buildHarness,
  connect,
  enableMcp,
  human,
  pkcePair,
  registerClient,
  seedUser,
  useHttpsInstance,
  type Harness,
} from '../../test/oauth/oauth-harness';
import { OAuthSweeper } from './oauth.sweeper';
import { REFRESH_REUSE_GRACE_MS } from './oauth.constants';

/**
 * The authorization server end to end over an in-memory database: registration → consent → code →
 * tokens → refresh → revocation, and the resource-server check W3-2 runs on every `/mcp` request.
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

function validParams(
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CODE_REDIRECT,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'lazyit.read lazyit.write',
    resource: RESOURCE,
    ...overrides,
  };
}

describe('the authorization server is absent without a pinned HTTPS origin', () => {
  it.each([
    ['a plain-HTTP lan instance (WEB_ORIGIN unset)', undefined, 'local'],
    ['an http:// origin', 'http://lazyit.lan', 'local'],
    ['the shim', ISSUER, 'shim'],
  ])('answers 404 on %s', async (_label, origin, mode) => {
    if (origin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = origin;
    process.env.AUTH_MODE = mode;
    const user = seedUser(h);
    await expect(
      h.registrations.register({ redirect_uris: [CLAUDE_CODE_REDIRECT] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.tokens.exchangeAuthorizationCode({ code: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.tokens.revokeByToken({ token: 'lzit_oat_x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.authorization.validate(human(user), validParams('lzc_x')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await h.tokens.verifyAccessToken('lzit_oat_x')).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('answers 404 while the MCP switch is off (and with no settings row at all)', async () => {
    enableMcp(h, { mcpEnabled: false });
    await expect(
      h.registrations.register({ redirect_uris: [CLAUDE_CODE_REDIRECT] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    h.prisma.tables.aiSettings = [];
    await expect(
      h.registrations.register({ redirect_uris: [CLAUDE_CODE_REDIRECT] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client whose redirect is allowlisted', async () => {
    const response = await h.registrations.register({
      client_name: 'Claude Code',
      redirect_uris: [CLAUDE_CODE_REDIRECT],
    });
    expect(response).toMatchObject({
      client_id: expect.stringMatching(/^lzc_/),
      token_endpoint_auth_method: 'none',
      redirect_uris: [CLAUDE_CODE_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
    });
    expect(response).not.toHaveProperty('client_secret');
    expect(h.prisma.tables.oAuthAuditLog).toEqual([
      expect.objectContaining({
        action: 'CLIENT_REGISTERED',
        clientId: response.client_id,
      }),
    ]);
  });

  it('refuses a client_name spoof: "Claude Code" with an unlisted redirect', async () => {
    expect(
      await oauthError(
        h.registrations.register({
          client_name: 'Claude Code',
          redirect_uris: ['https://attacker.example/callback'],
        }),
      ),
    ).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(h.prisma.tables.oAuthClient).toHaveLength(0);
  });

  it.each([
    'http://agent.example.com/callback',
    'javascript:alert(document.cookie)',
    'data:text/html,hi',
    'file:///tmp/x',
  ])('refuses the redirect %s', async (uri) => {
    expect(
      await oauthError(h.registrations.register({ redirect_uris: [uri] })),
    ).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('admits a private-use scheme only once an admin lists it explicitly', async () => {
    const uri = 'com.example.agent:/oauth/callback';
    enableMcp(h, { mcpAllowAnyHttpsClient: true });
    expect(
      await oauthError(h.registrations.register({ redirect_uris: [uri] })),
    ).toMatchObject({ error: 'invalid_redirect_uri' });

    enableMcp(h, {
      mcpClientAllowlistAdded: [
        {
          id: 'example-agent',
          label: 'Example agent',
          match: { kind: 'redirect_uri', pattern: uri },
        },
      ],
    });
    await expect(
      h.registrations.register({ redirect_uris: [uri] }),
    ).resolves.toMatchObject({ redirect_uris: [uri] });
  });

  describe('any HTTPS client by default (ADR-0097 decision 13, amended 2026-09-24)', () => {
    const httpsRedirect = 'https://agent.example.com/oauth/callback';

    it('reads the toggle as on when no settings row exists', async () => {
      h.prisma.tables.aiSettings = [];
      await expect(h.policy.mcpSettings()).resolves.toMatchObject({
        mcpEnabled: false,
        allowAnyHttpsClient: true,
      });
    });

    it('registers any HTTPS client when the row never stored the toggle', async () => {
      enableMcp(h, { mcpAllowAnyHttpsClient: undefined });
      await expect(
        h.registrations.register({ redirect_uris: [httpsRedirect] }),
      ).resolves.toMatchObject({ redirect_uris: [httpsRedirect] });
    });

    it('still refuses an unlisted HTTPS client while the stored value is false', async () => {
      enableMcp(h, { mcpAllowAnyHttpsClient: false });
      expect(
        await oauthError(
          h.registrations.register({ redirect_uris: [httpsRedirect] }),
        ),
      ).toMatchObject({ error: 'invalid_redirect_uri' });
      expect(h.prisma.tables.oAuthClient).toHaveLength(0);
    });

    it.each([
      'com.example.agent:/oauth/callback',
      'http://agent.example.com/callback',
    ])('still refuses %s without an explicit entry', async (uri) => {
      enableMcp(h, { mcpAllowAnyHttpsClient: undefined });
      expect(
        await oauthError(h.registrations.register({ redirect_uris: [uri] })),
      ).toMatchObject({ error: 'invalid_redirect_uri' });
    });
  });

  it('refuses a registration once the admin removed the default that listed it', async () => {
    enableMcp(h, {
      mcpClientAllowlistRemovedDefaults: ['loopback-localhost-callback'],
    });
    expect(
      await oauthError(
        h.registrations.register({ redirect_uris: [CLAUDE_CODE_REDIRECT] }),
      ),
    ).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('refuses confidential clients and unsupported grant types', async () => {
    expect(
      await oauthError(
        h.registrations.register({
          redirect_uris: [CLAUDE_CODE_REDIRECT],
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      ),
    ).toMatchObject({ error: 'invalid_client_metadata' });
    expect(
      await oauthError(
        h.registrations.register({
          redirect_uris: [CLAUDE_CODE_REDIRECT],
          grant_types: ['client_credentials'],
        }),
      ),
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('strips control and bidi characters from the self-declared name', async () => {
    const response = await h.registrations.register({
      client_name: 'Cla‮ude\u0000 Code',
      redirect_uris: [CLAUDE_CODE_REDIRECT],
    });
    expect(response.client_name).toBe('Claude Code');
  });
});

describe('consent: validate', () => {
  it('describes the request for the consent screen', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    expect(
      await h.authorization.validate(human(user), validParams(clientId)),
    ).toEqual({
      ok: true,
      client: {
        id: clientId,
        name: 'Claude Code',
        uri: null,
        verified: false,
        verifiedDomain: null,
      },
      redirectUri: CLAUDE_CODE_REDIRECT,
      redirectHost: 'localhost:53682',
      loopbackOnly: true,
      scopes: ['lazyit.read', 'lazyit.write'],
      user: { email: user.email },
    });
  });

  it('never preselects lazyit.admin: a request without scope asks for read + write', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const result = await h.authorization.validate(
      human(user),
      validParams(clientId, { scope: undefined }),
    );
    expect(result).toMatchObject({
      ok: true,
      scopes: ['lazyit.read', 'lazyit.write'],
    });
  });

  it('refuses (never redirects) an unknown client and an unregistered redirect', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    expect(
      await h.authorization.validate(human(user), validParams('lzc_unknown')),
    ).toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
    for (const redirect of [
      'http://localhost:53682/callback/',
      'http://localhost:53682/callback?x=1',
      'https://attacker.example/callback',
    ]) {
      expect(
        await h.authorization.validate(
          human(user),
          validParams(clientId, { redirect_uri: redirect }),
        ),
      ).toEqual({ ok: false, refusal: 'INVALID_REDIRECT' });
    }
  });

  it('refuses a registered client the admin has since taken off the allowlist', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    enableMcp(h, {
      mcpClientAllowlistRemovedDefaults: ['loopback-localhost-callback'],
    });
    expect(
      await h.authorization.validate(human(user), validParams(clientId)),
    ).toEqual({ ok: false, refusal: 'INVALID_CLIENT' });
  });

  it('refuses without ai:connect, for a service account, and with MCP off', async () => {
    const clientId = await registerClient(h);
    const viewer = seedUser(h, { role: 'VIEWER' });
    expect(
      await h.authorization.validate(human(viewer), validParams(clientId)),
    ).toEqual({ ok: false, refusal: 'FORBIDDEN' });
    expect(
      await h.authorization.validate(
        {
          kind: 'service',
          serviceAccount: {} as never,
          permissions: new Set(),
        },
        validParams(clientId),
      ),
    ).toEqual({ ok: false, refusal: 'FORBIDDEN' });
    enableMcp(h, { mcpEnabled: false });
    expect(
      await h.authorization.validate(human(seedUser(h)), validParams(clientId)),
    ).toEqual({ ok: false, refusal: 'AI_DISABLED' });
  });

  it.each([
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ scope: 'openid lazyit.read' }, 'invalid_scope'],
    [{ resource: 'https://other.example.com/mcp' }, 'invalid_target'],
  ])(
    'redirects %j back to the client as %s, with state and iss',
    async (override, error) => {
      const user = seedUser(h);
      const clientId = await registerClient(h);
      const response = (await oauthError(
        h.authorization.validate(human(user), validParams(clientId, override)),
      )) as { error: string; redirectTo: string };
      expect(response.error).toBe(error);
      const redirect = new URL(response.redirectTo);
      expect(`${redirect.origin}${redirect.pathname}`).toBe(
        CLAUDE_CODE_REDIRECT,
      );
      expect(redirect.searchParams.get('error')).toBe(error);
      expect(redirect.searchParams.get('state')).toBe('st-1');
      expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    },
  );
});

describe('consent: decision', () => {
  it('issues a single-use code bound to the redirect, with state and iss', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const { redirectTo } = await authorize(h, user, { clientId });
    const url = new URL(redirectTo);
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    expect(h.prisma.tables.oAuthAuthorizationCode).toHaveLength(1);
    const row = h.prisma.tables.oAuthAuthorizationCode[0] as {
      codeHash: string;
      expiresAt: Date;
    };
    expect(row.codeHash).not.toBe(url.searchParams.get('code'));
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it('redirects a denial with access_denied and audits it', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const { redirectTo } = await h.authorization.decision(human(user), {
      params: validParams(clientId),
      decision: 'deny',
    });
    expect(new URL(redirectTo).searchParams.get('error')).toBe('access_denied');
    expect(h.prisma.tables.oAuthAuthorizationCode).toHaveLength(0);
    expect(h.prisma.tables.oAuthAuditLog.at(-1)).toMatchObject({
      action: 'CONSENT_DENIED',
      userId: user.id,
    });
  });

  it('narrows the scope to what the user granted', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user, { grantScopes: ['lazyit.read'] });
    expect(tokens.scope).toBe('lazyit.read');
    const verified = await h.tokens.verifyAccessToken(tokens.access_token);
    expect(verified).toMatchObject({
      ok: true,
      grant: { scopes: ['lazyit.read'] },
    });
  });

  it('refuses to grant more than the client asked for', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    await expect(
      h.authorization.decision(human(user), {
        params: validParams(clientId, { scope: 'lazyit.read' }),
        decision: 'approve',
        scopes: ['lazyit.read', 'lazyit.write'],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  describe('lazyit.admin needs a password step-up', () => {
    const adminParams = (clientId: string) =>
      validParams(clientId, { scope: 'lazyit.read lazyit.write lazyit.admin' });

    it('is refused without the password', async () => {
      const user = seedUser(h);
      const clientId = await registerClient(h);
      await expect(
        h.authorization.decision(human(user), {
          params: adminParams(clientId),
          decision: 'approve',
          scopes: ['lazyit.read', 'lazyit.admin'],
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'STEP_UP_REQUIRED' }),
      });
    });

    it('is refused with a wrong password', async () => {
      const user = seedUser(h);
      const clientId = await registerClient(h);
      await expect(
        h.authorization.decision(human(user), {
          params: adminParams(clientId),
          decision: 'approve',
          scopes: ['lazyit.admin'],
          password: 'wrong',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'STEP_UP_FAILED' }),
      });
      expect(h.prisma.tables.oAuthAuthorizationCode).toHaveLength(0);
    });

    it('is granted with the right password', async () => {
      const user = seedUser(h);
      const { tokens } = await connect(h, user, {
        scope: 'lazyit.read lazyit.write lazyit.admin',
        grantScopes: ['lazyit.read', 'lazyit.write', 'lazyit.admin'],
        password: PASSWORD,
      });
      expect(tokens.scope).toBe('lazyit.read lazyit.write lazyit.admin');
    });

    it('cannot be granted outside local mode (no password to step up with)', async () => {
      const user = seedUser(h);
      const clientId = await registerClient(h);
      process.env.AUTH_MODE = 'oidc';
      await expect(
        h.authorization.decision(human(user), {
          params: adminParams(clientId),
          decision: 'approve',
          scopes: ['lazyit.admin'],
          password: PASSWORD,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'STEP_UP_UNAVAILABLE' }),
      });
    });
  });
});

describe('token endpoint: authorization_code', () => {
  async function codeFor(user: unknown) {
    const clientId = await registerClient(h);
    const issued = await authorize(h, user, { clientId });
    return { clientId, ...issued };
  }

  it('exchanges a code for opaque tokens bound to /mcp', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'lazyit.read lazyit.write',
      access_token: expect.stringMatching(/^lzit_oat_/),
      refresh_token: expect.stringMatching(/^lzit_ort_/),
    });
    expect(tokens).not.toHaveProperty('id_token');
    expect(h.prisma.tables.oAuthGrant).toEqual([
      expect.objectContaining({
        userId: user.id,
        resource: RESOURCE,
        sessionEpoch: 0,
        mcpCredentialEpoch: 0,
        scopes: ['lazyit.read', 'lazyit.write'],
      }),
    ]);
  });

  it('accepts a code only once', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    const request = {
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CODE_REDIRECT,
      resource: RESOURCE,
    };
    await h.tokens.exchangeAuthorizationCode(request);
    expect(
      await oauthError(h.tokens.exchangeAuthorizationCode(request)),
    ).toEqual({ error: 'invalid_grant' });
    expect(h.prisma.tables.oAuthGrant).toHaveLength(1);
  });

  it('refuses an expired code (60 s)', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    jest.useFakeTimers({ now: Date.now() + 61_000 });
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CLAUDE_CODE_REDIRECT,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('requires the PKCE verifier and burns the code on a wrong one', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    const base = {
      code,
      client_id: clientId,
      redirect_uri: CLAUDE_CODE_REDIRECT,
    };
    expect(
      await oauthError(h.tokens.exchangeAuthorizationCode(base)),
    ).toMatchObject({ error: 'invalid_request' });
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          ...base,
          code_verifier: pkcePair().verifier,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
    // The right verifier no longer helps: the code was consumed by the failed attempt.
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          ...base,
          code_verifier: verifier,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('requires the exact redirect_uri of the authorization request', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: 'http://localhost:53683/callback',
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('refuses a code presented by another client', async () => {
    const user = seedUser(h);
    const { code, verifier } = await codeFor(user);
    const other = await registerClient(h);
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          code,
          code_verifier: verifier,
          client_id: other,
          redirect_uri: CLAUDE_CODE_REDIRECT,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('refuses a wrong resource (RFC 8707)', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CLAUDE_CODE_REDIRECT,
          resource: 'https://other.example.com/mcp',
        }),
      ),
    ).toMatchObject({ error: 'invalid_target' });
  });

  it('refuses a user deactivated between consent and exchange', async () => {
    const user = seedUser(h);
    const { clientId, code, verifier } = await codeFor(user);
    user.isActive = false;
    expect(
      await oauthError(
        h.tokens.exchangeAuthorizationCode({
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CLAUDE_CODE_REDIRECT,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });
});

describe('token endpoint: refresh_token', () => {
  it('rotates: the new pair works, the old refresh token is spent', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    const refreshed = await h.tokens.refresh({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      await h.tokens.verifyAccessToken(refreshed.access_token),
    ).toMatchObject({ ok: true });
  });

  it('treats a replay inside the grace window as a race: invalid_grant, grant kept', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    const request = {
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    };
    const refreshed = await h.tokens.refresh(request);
    expect(await oauthError(h.tokens.refresh(request))).toEqual({
      error: 'invalid_grant',
    });
    expect(
      await h.tokens.verifyAccessToken(refreshed.access_token),
    ).toMatchObject({ ok: true });
  });

  it('revokes the whole family when a rotated refresh token is reused', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    const request = {
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    };
    const refreshed = await h.tokens.refresh(request);
    jest.useFakeTimers({ now: Date.now() + REFRESH_REUSE_GRACE_MS + 1_000 });
    expect(await oauthError(h.tokens.refresh(request))).toEqual({
      error: 'invalid_grant',
    });
    expect(h.prisma.tables.oAuthGrant[0]).toMatchObject({
      revokeReason: 'refresh_reuse',
      deletedAt: expect.any(Date),
    });
    expect(
      await h.tokens.verifyAccessToken(refreshed.access_token),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await oauthError(
        h.tokens.refresh({
          refresh_token: refreshed.refresh_token,
          client_id: clientId,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
    expect(
      h.prisma.tables.oAuthAuditLog.map((row) => row.action as string),
    ).toEqual(
      expect.arrayContaining(['REFRESH_REUSE_DETECTED', 'GRANT_REVOKED']),
    );
  });

  it('never widens the scope, and does not narrow it silently', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user, {
      grantScopes: ['lazyit.read'],
    });
    const base = { refresh_token: tokens.refresh_token, client_id: clientId };
    expect(
      await oauthError(
        h.tokens.refresh({ ...base, scope: 'lazyit.read lazyit.write' }),
      ),
    ).toMatchObject({ error: 'invalid_scope' });
    expect(
      await h.tokens.refresh({ ...base, scope: 'lazyit.read' }),
    ).toMatchObject({ scope: 'lazyit.read' });
  });

  it('refuses a refresh token presented by another client, or with a wrong resource', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    const other = await registerClient(h);
    expect(
      await oauthError(
        h.tokens.refresh({
          refresh_token: tokens.refresh_token,
          client_id: other,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
    expect(
      await oauthError(
        h.tokens.refresh({
          refresh_token: tokens.refresh_token,
          client_id: clientId,
          resource: 'https://other.example.com/mcp',
        }),
      ),
    ).toMatchObject({ error: 'invalid_target' });
  });
});

describe('tokens die with the user', () => {
  it('an mcpCredentialEpoch bump kills access and refresh tokens', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    // Password change or reset, admin reset, deactivation, offboarding: both counters move.
    user.sessionEpoch += 1;
    user.mcpCredentialEpoch += 1;
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'session_revoked', status: 401 },
    );
    expect(
      await oauthError(
        h.tokens.refresh({
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('a web logout (sessionEpoch bump alone) keeps access and refresh tokens alive (ADR-0097 d8 amended)', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    user.sessionEpoch += 1; // what LoginService.logout does — and nothing else
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: true },
    );
    const refreshed = await h.tokens.refresh({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.access_token).toMatch(/^lzit_oat_/);
    expect(
      await h.tokens.verifyAccessToken(refreshed.access_token),
    ).toMatchObject({ ok: true });
  });

  it('a grant the migration marked already dead (-1) stays dead', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    h.prisma.tables.oAuthGrant[0].mcpCredentialEpoch = -1;
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'session_revoked', status: 401 },
    );
  });

  it('deactivation kills access and refresh tokens', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    user.isActive = false;
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'inactive', status: 401 },
    );
    expect(
      await oauthError(
        h.tokens.refresh({
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      ),
    ).toEqual({ error: 'invalid_grant' });
  });

  it('offboarding (soft delete), directory-only and a forced password change kill access tokens', async () => {
    for (const change of [
      { deletedAt: new Date() },
      { directoryOnly: true },
      { mustChangePassword: true },
    ]) {
      const user = seedUser(h);
      const { tokens } = await connect(h, user);
      Object.assign(user, change);
      expect(
        await h.tokens.verifyAccessToken(tokens.access_token),
      ).toMatchObject({ ok: false, status: 401 });
    }
  });
});

describe('verifyAccessToken — the /mcp resource-server check', () => {
  it('returns the principal, the grant and the audience', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toEqual({
      ok: true,
      principal: {
        kind: 'human',
        user: expect.objectContaining({ id: user.id }),
      },
      grant: {
        id: h.prisma.tables.oAuthGrant[0].id,
        clientId,
        clientName: 'Claude Code',
        scopes: ['lazyit.read', 'lazyit.write'],
      },
      resource: RESOURCE,
      expiresAt: expect.any(Date),
    });
  });

  it('refuses a token issued for another audience (the issuer moved)', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    process.env.WEB_ORIGIN = 'https://renamed.example.com';
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'wrong_audience', status: 401 },
    );
  });

  it('refuses an expired access token (1 h)', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    jest.useFakeTimers({ now: Date.now() + 3600_000 + 1 });
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'expired' },
    );
  });

  it('refuses a refresh token, a session JWT and garbage presented as an access token', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    for (const presented of [
      tokens.refresh_token,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
      'lzit_oat_not-a-real-token',
    ]) {
      expect(await h.tokens.verifyAccessToken(presented)).toMatchObject({
        ok: false,
        status: 401,
      });
    }
  });

  it('answers 403 when MCP is switched off or ai:connect is withdrawn', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    enableMcp(h, { mcpEnabled: false });
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'mcp_disabled', status: 403 },
    );
    enableMcp(h);
    h.rolePermissions.set('MEMBER', new Set());
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false, reason: 'forbidden', status: 403 },
    );
  });
});

describe('revocation', () => {
  it('RFC 7009: revoking the refresh token revokes the grant and its access token', async () => {
    const user = seedUser(h);
    const { clientId, tokens } = await connect(h, user);
    await h.tokens.revokeByToken({
      token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(h.prisma.tables.oAuthGrant[0]).toMatchObject({
      revokeReason: 'revocation_endpoint',
    });
    expect(h.prisma.tables.oAuthToken).toHaveLength(0);
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false },
    );
  });

  it('ignores unknown tokens and another client’s token without an error', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    await expect(
      h.tokens.revokeByToken({ token: 'lzit_oat_unknown' }),
    ).resolves.toBeUndefined();
    await h.tokens.revokeByToken({
      token: tokens.access_token,
      client_id: 'lzc_someone-else',
    });
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: true },
    );
  });
});

describe('connected apps', () => {
  it('lists only the caller’s live grants', async () => {
    const user = seedUser(h);
    const other = seedUser(h);
    await connect(h, user);
    await connect(h, other);
    const mine = await h.grants.listMine(user);
    expect(mine).toEqual([
      expect.objectContaining({
        kind: 'oauth',
        client: { name: 'Claude Code', verified: false },
        redirectHost: 'localhost:53682',
        scopes: ['lazyit.read', 'lazyit.write'],
      }),
    ]);
    // A web logout leaves the list intact…
    user.sessionEpoch += 1;
    expect(await h.grants.listMine(user)).toHaveLength(1);
    expect(await h.grants.listForAdmin(user.id)).toHaveLength(1);
    // …a credential event (password change, deactivation, offboarding) empties it.
    user.mcpCredentialEpoch += 1;
    expect(await h.grants.listMine(user)).toEqual([]);
    expect(await h.grants.listForAdmin(user.id)).toEqual([]);
  });

  it('lets the owner revoke, hides other users’ grants (404), and lets an admin revoke any', async () => {
    const owner = seedUser(h);
    const stranger = seedUser(h);
    const admin = seedUser(h, { role: 'ADMIN' });
    await connect(h, owner);
    await connect(h, owner);
    const [first, second] = h.prisma.tables.oAuthGrant;
    await expect(h.grants.revoke(stranger, first.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await h.grants.revoke(owner, first.id);
    expect(first).toMatchObject({
      revokeReason: 'user',
      revokedById: owner.id,
    });
    await h.grants.revoke(admin, second.id);
    expect(second).toMatchObject({
      revokeReason: 'admin',
      revokedById: admin.id,
    });
    expect(await h.grants.listForAdmin(owner.id)).toEqual([]);
  });
});

describe('credential hygiene', () => {
  it('never stores a code, access token or refresh token in cleartext', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h);
    const { code, verifier } = await authorize(h, user, { clientId });
    const tokens = await h.tokens.exchangeAuthorizationCode({
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CODE_REDIRECT,
    });
    const refreshed = await h.tokens.refresh({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    const everything = JSON.stringify(h.prisma.tables);
    for (const secret of [
      code,
      verifier,
      tokens.access_token,
      tokens.refresh_token,
      refreshed.access_token,
      refreshed.refresh_token,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('the sweeper', () => {
  it('collects expired codes and tokens and unused registrations, keeping live state', async () => {
    const user = seedUser(h);
    const { tokens } = await connect(h, user);
    await registerClient(h); // never used
    const sweeper = new OAuthSweeper(h.prisma as never);

    let result = await sweeper.sweep(new Date());
    expect(result.codes).toBe(1); // the used code
    expect(result.tokens).toBe(0);
    expect(result.clients).toBe(0);

    result = await sweeper.sweep(new Date(Date.now() + 2 * 24 * 3600_000));
    expect(result.tokens).toBe(1); // the access token; the refresh token lives 30 days
    expect(result.clients).toBe(1); // the unused registration; the connected client stays
    expect(h.prisma.tables.oAuthGrant).toHaveLength(1);
    expect(await h.tokens.verifyAccessToken(tokens.access_token)).toMatchObject(
      { ok: false },
    );
  });
});

describe('review fixes (G3 review of #1339)', () => {
  it('#1: refuses to register a userinfo redirect that reads as loopback, even when an admin lists it', async () => {
    const uri = 'http://localhost:80@evil.com/callback';
    enableMcp(h, {
      mcpClientAllowlistAdded: [
        {
          id: 'smuggled',
          label: 'smuggled',
          match: { kind: 'redirect_uri', pattern: uri },
        },
      ],
    });
    expect(
      await oauthError(h.registrations.register({ redirect_uris: [uri] })),
    ).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(h.prisma.tables.oAuthClient).toHaveLength(0);
  });

  it('#7: refuses to register a redirect with an out-of-range port', async () => {
    expect(
      await oauthError(
        h.registrations.register({
          redirect_uris: ['http://localhost:99999/callback'],
        }),
      ),
    ).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('#7: a request redirect that cannot be parsed is refused with no 500 and no orphan code', async () => {
    const user = seedUser(h);
    const clientId = await registerClient(h, ['http://localhost/callback']);
    const params = validParams(clientId, {
      redirect_uri: 'http://localhost:99999/callback',
    });
    expect(await h.authorization.validate(human(user), params)).toEqual({
      ok: false,
      refusal: 'INVALID_REDIRECT',
    });
    await expect(
      h.authorization.decision(human(user), {
        params,
        decision: 'approve',
        scopes: ['lazyit.read'],
      }),
    ).rejects.toMatchObject({ refusal: 'INVALID_REDIRECT' });
    expect(h.prisma.tables.oAuthAuthorizationCode).toHaveLength(0);
  });
});
