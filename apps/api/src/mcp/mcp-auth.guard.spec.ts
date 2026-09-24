/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
// The generated client never loads under Jest (no DB); the OAuth services run over FakeOAuthPrisma.
jest.mock('../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../generated/prisma/enums',
  );
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: {} };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CreatePersonalTokenSchema } from '@lazyit/shared';
import {
  ISSUER,
  buildHarness,
  connect,
  enableMcp,
  seedUser,
  type Harness,
} from '../../test/oauth/oauth-harness';
import { payloadOf, toolsCall, toolsList } from '../../test/mcp/mcp-rpc';
import { AiToolService } from '../ai/core/ai-tool.service';
import { AiPromptService } from '../ai/prompt/ai-prompt.module';
import { AiRunPrincipals } from '../ai/runtime/principal-context';
import { PrincipalLoaderService } from '../auth/principal-loader.service';
import { ServiceAccountAuthenticator } from '../auth/service-account-authenticator';
import { NotificationsService } from '../notifications/notifications.service';
import { OAuthAuditService } from '../oauth/oauth-audit.service';
import { OAuthPolicyService } from '../oauth/oauth-policy.service';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { PersonalTokensService } from '../oauth/personal-tokens/personal-tokens.service';
import { PrismaService } from '../prisma/prisma.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpConnectionNoticeService } from './mcp-connection-notice.service';
import { McpRateLimiter } from './mcp-rate-limit';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';

/**
 * The `/mcp` AUTHENTICATION MATRIX (W3-2 + W3-4; gate G3): the real `McpAuthGuard` over the REAL
 * authorization-server token check (`OAuthTokenService.verifyAccessToken`) and the REAL personal-token
 * verifier, both over the in-memory database, behind the real controller and SDK handler. Service
 * Account verification is the shared `ServiceAccountAuthenticator` (its own specs) and is stubbed here.
 * The tool core is stubbed to one `whoami` read tool that reports the context it was called with.
 */

const HOST = 'lazyit.example.com';
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const ENV_KEYS = ['WEB_ORIGIN', 'AUTH_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};

const useHttps = () => {
  process.env.WEB_ORIGIN = ISSUER;
  process.env.AUTH_MODE = 'local';
};
const useLan = () => {
  delete process.env.WEB_ORIGIN;
  process.env.AUTH_MODE = 'local';
};

const WHOAMI = {
  name: 'whoami',
  title: 'Who am I',
  description: 'Echo the calling context.',
  class: 'read' as const,
  inputSchema: { type: 'object', properties: {} },
  permissions: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Service Accounts the stubbed authenticator knows: bearer → permissions and AI access. */
const SERVICE_ACCOUNTS: Record<
  string,
  { id: string; permissions: string[]; access: string }
> = {
  lzit_sa_connect_x: {
    id: 'sa-connect',
    permissions: ['ai:connect', 'user:read'],
    access: 'read-write',
  },
  lzit_sa_readonly_x: {
    id: 'sa-readonly',
    permissions: ['ai:connect'],
    access: 'read-only',
  },
  lzit_sa_off_x: { id: 'sa-off', permissions: ['ai:connect'], access: 'off' },
  lzit_sa_noconnect_x: {
    id: 'sa-noconnect',
    permissions: ['user:read'],
    access: 'read-write',
  },
  lzit_sa_agent_x: {
    id: 'sa-agent',
    permissions: ['ai:connect', 'infra:report'],
    access: 'read-write',
  },
};

describe('/mcp authentication matrix', () => {
  let app: INestApplication<App>;
  let h: Harness;
  let personal: PersonalTokensService;
  const tools = {
    list: jest.fn(),
    invoke: jest.fn(),
  };
  const notifications = { emit: jest.fn().mockResolvedValue('ckn') };

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    useHttps();
    h = buildHarness();
    enableMcp(h);
    const db = h.prisma as any;
    personal = new PersonalTokensService(
      db,
      h.policy,
      h.subjects,
      new PrincipalLoaderService(db),
      h.tokens,
      new OAuthAuditService(db),
    );
    tools.list.mockReset().mockResolvedValue([WHOAMI]);
    tools.invoke.mockReset().mockImplementation((_name, _input, ctx) =>
      Promise.resolve({
        ok: true,
        kind: 'read',
        data: { ctx },
        mutated: false,
        entityRefs: [],
      }),
    );
    notifications.emit.mockClear();

    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpAuthGuard,
        McpServerFactory,
        McpRateLimiter,
        McpConnectionNoticeService,
        AiPromptService,
        { provide: PrismaService, useValue: db },
        { provide: OAuthPolicyService, useValue: h.policy },
        { provide: OAuthTokenService, useValue: h.tokens },
        { provide: PersonalTokensService, useValue: personal },
        { provide: AiToolService, useValue: tools },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: ServiceAccountAuthenticator,
          useValue: {
            isServiceAccountToken: (b: string) => b.startsWith('lzit_sa_'),
            authenticate: (b: string) => {
              const sa = SERVICE_ACCOUNTS[b];
              if (!sa) {
                return Promise.reject(
                  new UnauthorizedException('Invalid service-account token'),
                );
              }
              return Promise.resolve({
                kind: 'service',
                serviceAccount: { id: sa.id, name: sa.id, expiresAt: null },
                permissions: new Set(sa.permissions),
              });
            },
          },
        },
        {
          provide: AiRunPrincipals,
          useValue: {
            serviceAccountSettings: (id: string) =>
              Promise.resolve({
                access: Object.values(SERVICE_ACCOUNTS).find(
                  (sa) => sa.id === id,
                )!.access,
                maxMutationsPerRun: null,
              }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function list(token?: string, headers: Record<string, string> = {}) {
    const rpc = toolsList();
    const req = request(app.getHttpServer())
      .post('/mcp')
      .set('host', HOST)
      .set(rpc.headers)
      .set(headers);
    if (token) req.set('authorization', `Bearer ${token}`);
    return req.send(rpc.body);
  }

  /** The context the tool core was asked to list with (the verified caller, as core sees it). */
  const listedWith = () => tools.list.mock.calls.at(-1)?.[0];

  async function oauthAccessToken(user: any, scopes?: string[]) {
    const { tokens } = await connect(h, user, {
      ...(scopes ? { scope: scopes.join(' '), grantScopes: scopes } : {}),
    });
    return tokens.access_token;
  }

  async function personalToken(user: any, scopes?: string[]) {
    const created = await personal.create(
      user,
      CreatePersonalTokenSchema.parse({
        label: 'laptop',
        ...(scopes ? { scopes } : {}),
      }),
    );
    return created.token;
  }

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  describe('the capability exists', () => {
    it('answers 404 to everyone while MCP is switched off — before reading any token', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      enableMcp(h, { mcpEnabled: false });
      await list().expect(404);
      await list(token).expect(404);
      h.prisma.tables.aiSettings = [];
      await list(token).expect(404);
      expect(tools.list).not.toHaveBeenCalled();
    });

    it('answers 404 in the shim', async () => {
      process.env.AUTH_MODE = 'shim';
      await list('lzit_oat_x').expect(404);
    });
  });

  describe('HTTPS instance (OAuth)', () => {
    it('challenges a tokenless request with RFC 9728 discovery (resource_metadata + scope)', async () => {
      const res = await list().expect(401);
      expect(res.headers['www-authenticate']).toBe(
        `Bearer resource_metadata="${RESOURCE_METADATA}", scope="lazyit.read lazyit.write"`,
      );
    });

    it('accepts a live OAuth access token and lists as its user, under its scope ceiling', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      const res = await list(token).expect(200);
      expect(payloadOf(res).result.tools.map((t: any) => t.name)).toEqual([
        'whoami',
      ]);
      expect(listedWith()).toMatchObject({
        channel: 'MCP',
        identity: { kind: 'human', userId: user.id, sessionEpoch: 0 },
        ceiling: ['read', 'write'],
        mcp: { clientId: expect.stringMatching(/^lzc_/) },
      });
    });

    it('applies the scope hierarchy: lazyit.read alone is read-only', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user, ['lazyit.read']);
      await list(token).expect(200);
      expect(listedWith().ceiling).toEqual(['read']);
    });

    it('passes the same context to tools/call (core re-checks it on every call)', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user, ['lazyit.read']);
      const rpc = toolsCall('whoami', {});
      const res = await request(app.getHttpServer())
        .post('/mcp')
        .set('host', HOST)
        .set(rpc.headers)
        .set('authorization', `Bearer ${token}`)
        .send(rpc.body)
        .expect(200);
      expect(payloadOf(res).result.structuredContent.data.ctx).toMatchObject({
        channel: 'MCP',
        ceiling: ['read'],
        identity: { userId: user.id },
      });
    });

    it.each([
      ['a revoked grant', 'revoked'],
      ['a sessionEpoch bump (password change, sign out everywhere)', 'epoch'],
      ['a deactivated user', 'inactive'],
      ['a forced password change', 'mustChange'],
      ['the wrong audience', 'audience'],
      ['an expired access token', 'expired'],
    ])(
      'refuses %s with 401 invalid_token and the challenge',
      async (_l, kind) => {
        const user = seedUser(h);
        const token = await oauthAccessToken(user);
        const grant = h.prisma.tables.oAuthGrant[0];
        const row = h.prisma.tables.user.find((u) => u.id === user.id)!;
        if (kind === 'revoked') {
          await h.tokens.revokeGrant(grant.id, 'user', user.id);
        } else if (kind === 'epoch') {
          row.sessionEpoch += 1;
        } else if (kind === 'inactive') {
          row.isActive = false;
        } else if (kind === 'mustChange') {
          row.mustChangePassword = true;
        } else if (kind === 'audience') {
          grant.resource = 'https://other.example.com/mcp';
        } else {
          h.prisma.tables.oAuthToken
            .filter((t) => t.kind === 'access')
            .forEach((t) => (t.expiresAt = new Date(Date.now() - 1000)));
        }
        const res = await list(token).expect(401);
        expect(res.headers['www-authenticate']).toContain(
          `resource_metadata="${RESOURCE_METADATA}"`,
        );
        expect(res.headers['www-authenticate']).toContain(
          'error="invalid_token"',
        );
        expect(tools.list).not.toHaveBeenCalled();
      },
    );

    it('answers 403 (no challenge) when a valid token meets a withdrawn ai:connect', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      h.rolePermissions.set('MEMBER', new Set());
      const res = await list(token).expect(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.body).toMatchObject({ error: 'access_denied' });
    });

    it.each([
      ['a local session JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
      ['a refresh token', 'lzit_ort_abcdef'],
      ['an unknown access token', 'lzit_oat_abcdef'],
      ['garbage', 'hello'],
    ])('refuses %s (no token passthrough)', async (_l, token) => {
      const res = await list(token).expect(401);
      expect(res.headers['www-authenticate']).toContain(
        'error="invalid_token"',
      );
    });

    it('refuses a personal token: OAuth is the only path on an HTTPS instance', async () => {
      useLan();
      const user = seedUser(h);
      const pat = await personalToken(user);
      useHttps();
      const res = await list(pat).expect(401);
      expect(res.body.error_description).toMatch(/uses OAuth/);
    });

    it('never reads a token from the query string', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      const rpc = toolsList();
      await request(app.getHttpServer())
        .post(`/mcp?access_token=${token}`)
        .set('host', HOST)
        .set(rpc.headers)
        .send(rpc.body)
        .expect(400);
    });

    it('accepts the Bearer scheme case-insensitively', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      const rpc = toolsList();
      await request(app.getHttpServer())
        .post('/mcp')
        .set('host', HOST)
        .set(rpc.headers)
        .set('authorization', `bearer ${token}`)
        .send(rpc.body)
        .expect(200);
    });
  });

  describe('transport (Origin / Host)', () => {
    it('refuses a cross-site Origin with 403 and admits the instance’s own', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      await list(token, { origin: 'https://evil.example' }).expect(403);
      await list(token, { origin: 'null' }).expect(403);
      await list(token, { origin: ISSUER }).expect(200);
    });

    it('refuses a Host that is not the pinned origin (DNS rebinding)', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      const rpc = toolsList();
      await request(app.getHttpServer())
        .post('/mcp')
        .set('host', 'attacker.example')
        .set(rpc.headers)
        .set('authorization', `Bearer ${token}`)
        .send(rpc.body)
        .expect(403);
    });

    it('on lan (no pinned origin) compares Origin with the request Host', async () => {
      useLan();
      const user = seedUser(h);
      const pat = await personalToken(user);
      await list(pat, { origin: `http://${HOST}` }).expect(200);
      await list(pat, { origin: 'http://evil.example' }).expect(403);
    });
  });

  describe('lan instance (personal tokens)', () => {
    beforeEach(() => useLan());

    it('challenges with a plain Bearer realm — no authorization server to discover', async () => {
      const res = await list().expect(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="lazyit"');
    });

    it('accepts a live personal token under its scopes', async () => {
      const user = seedUser(h);
      const pat = await personalToken(user);
      await list(pat).expect(200);
      expect(listedWith()).toMatchObject({
        identity: { kind: 'human', userId: user.id },
        ceiling: ['read', 'write'],
        mcp: { clientId: 'personal' },
      });
      const readOnly = await personalToken(user, ['lazyit.read']);
      await list(readOnly).expect(200);
      expect(listedWith().ceiling).toEqual(['read']);
    });

    it('refuses an OAuth token: there is no authorization server here', async () => {
      useHttps();
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      useLan();
      const res = await list(token).expect(401);
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="lazyit", error="invalid_token", error_description="This instance does not use OAuth for AI agents: use a personal MCP token."',
      );
    });

    it.each(['revoked', 'epoch', 'offboarded'])(
      'refuses a personal token after %s',
      async (kind) => {
        const user = seedUser(h);
        const pat = await personalToken(user);
        const grant = h.prisma.tables.oAuthGrant[0];
        const row = h.prisma.tables.user.find((u) => u.id === user.id)!;
        if (kind === 'revoked') await personal.revokeMine(user, grant.id);
        if (kind === 'epoch') row.sessionEpoch += 1;
        if (kind === 'offboarded') row.deletedAt = new Date();
        await list(pat).expect(401);
      },
    );
  });

  describe('Service Accounts (R10: fail-closed, ai:connect)', () => {
    it.each([
      ['HTTPS', useHttps],
      ['lan', useLan],
    ])(
      'accept an SA holding ai:connect on %s, with no scope ceiling beyond its grants',
      async (_l, mode) => {
        mode();
        await list('lzit_sa_connect_x').expect(200);
        expect(listedWith()).toMatchObject({
          identity: { kind: 'service', serviceAccountId: 'sa-connect' },
          ceiling: ['read', 'write', 'elevated'],
        });
        expect(listedWith().mcp).toBeUndefined();
      },
    );

    it('caps a read-only SA at read tools', async () => {
      await list('lzit_sa_readonly_x').expect(200);
      expect(listedWith().ceiling).toEqual(['read']);
    });

    it.each([
      ['without ai:connect', 'lzit_sa_noconnect_x'],
      ['holding infra:report (the fleet agent token)', 'lzit_sa_agent_x'],
      ['whose AI access is off', 'lzit_sa_off_x'],
    ])('refuse an SA %s with 403', async (_l, token) => {
      await list(token).expect(403);
      expect(tools.list).not.toHaveBeenCalled();
    });

    it('refuses an invalid SA token with 401', async () => {
      await list('lzit_sa_unknown_x').expect(401);
    });
  });

  describe('abuse controls', () => {
    it('rate-limits refused authentications per client IP (429)', async () => {
      for (let i = 0; i < 30; i += 1) {
        await list('lzit_oat_wrong').expect(401);
      }
      await list('lzit_oat_wrong').expect(429);
      // A tokenless discovery probe is not a refusal, but the address stays blocked while over the limit.
      await list().expect(429);
    });

    it('notifies the owner ONCE when an OAuth connection is first used', async () => {
      const user = seedUser(h);
      const token = await oauthAccessToken(user);
      await list(token).expect(200);
      await list(token).expect(200);
      await flush();
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const grant = h.prisma.tables.oAuthGrant[0];
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp.client_connected',
          dedupeKey: `mcp.client_connected:${grant.id}`,
          recipientUserId: user.id,
          severity: 'warning',
        }),
      );
      expect(JSON.stringify(notifications.emit.mock.calls)).not.toContain(
        token,
      );
    });

    it('notifies on a personal token’s first use, and never for a Service Account', async () => {
      useLan();
      const user = seedUser(h);
      const pat = await personalToken(user);
      await list(pat).expect(200);
      await list('lzit_sa_connect_x').expect(200);
      await flush();
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      expect(notifications.emit.mock.calls[0][0]).toMatchObject({
        type: 'mcp.client_connected',
        metadata: { kind: 'personal' },
      });
    });
  });
});
