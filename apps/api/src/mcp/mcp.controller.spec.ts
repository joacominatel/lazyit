/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import {
  NotFoundException,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type OAuthScope,
  type Role,
} from '@lazyit/shared';

jest.mock('../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import {
  modern,
  legacyToolsList,
  payloadOf,
  toolsCall,
  toolsList,
  type McpRpc,
} from '../../test/mcp/mcp-rpc';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AiActionLogService } from '../ai/core/action-log.service';
import { AiToolService } from '../ai/core/ai-tool.service';
import { AiToolDispatcher } from '../ai/core/tool-dispatcher';
import { AiToolExecutor } from '../ai/core/tool-executor';
import { AI_TOOLSETS, AiToolRegistry } from '../ai/core/tool-registry';
import { AiPromptService } from '../ai/prompt/ai-prompt.module';
import { buildMcpInstructions } from '../ai/prompt/system-prompt';
import { AiRunPrincipals } from '../ai/runtime/principal-context';
import { usersToolset } from '../ai/tools/users.tools';
import { ApplicationsController } from '../applications/applications.controller';
import { ApplicationsService } from '../applications/applications.service';
import { ArticlesService } from '../articles/articles.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LocalCredentialService } from '../auth/local/local-credential.service';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../auth/principal-loader.service';
import { RolesGuard } from '../auth/roles.guard';
import { ServiceAccountAuthenticator } from '../auth/service-account-authenticator';
import { ActorService } from '../common/actor.service';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';
import { OAuthPolicyService } from '../oauth/oauth-policy.service';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { PersonalTokensService } from '../oauth/personal-tokens/personal-tokens.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpConnectionNoticeService } from './mcp-connection-notice.service';
import { McpRateLimiter } from './mcp-rate-limit';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';

/**
 * `/mcp` END TO END (W3-2): real HTTP → the real `McpAuthGuard` → the SDK v2 stateless handler inside the
 * real `McpController` → the per-caller `McpServerFactory` → the REAL AI core (registry, dispatcher,
 * executor, ledger) running the REAL users toolset through the REAL `UsersController` and
 * `ApplicationsController` behind the real guard chain. Only token verification (covered by
 * `mcp-auth.guard.spec.ts`), Prisma (in memory) and the domain services under the controllers are stubbed.
 *
 * Pins: the listing honours the scope ceiling AND the principal's permissions; annotations come from the
 * class; results and errors map to `structuredContent` / `isError`; a write on a critical application is
 * refused over MCP by the real `user_offboard` tool before any side effect; the 2025-era leg works; and
 * the route is `@Public()` behind `McpAuthGuard`.
 */

const ISSUER = 'https://lazyit.example.com';
const ID = {
  admin: 'aaaaaaaa-0000-4000-8000-000000000001',
  member: 'aaaaaaaa-0000-4000-8000-000000000002',
  viewer: 'aaaaaaaa-0000-4000-8000-000000000003',
  target: 'aaaaaaaa-0000-4000-8000-000000000004',
};
const APP_ID = 'ckapp0000000000000000001';

const T0 = new Date('2026-09-01T00:00:00.000Z');
function userRow(id: string, role: Role) {
  return {
    id,
    email: `${role.toLowerCase()}-${id.slice(-1)}@example.com`,
    firstName: role,
    lastName: 'User',
    role,
    isActive: true,
    directoryOnly: false,
    mustChangePassword: false,
    sessionEpoch: 1,
    externalId: null,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
  };
}
const USERS: Record<string, ReturnType<typeof userRow>> = {
  [ID.admin]: userRow(ID.admin, 'ADMIN'),
  [ID.member]: userRow(ID.member, 'MEMBER'),
  [ID.viewer]: userRow(ID.viewer, 'VIEWER'),
  [ID.target]: userRow(ID.target, 'MEMBER'),
};

let invocations: Map<string, Record<string, unknown>>;
let ledger: Array<Record<string, unknown>>;
let nextId = 0;

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, cond]) => row[key] === cond);
}

/** The in-memory client, for `$transaction` (a function, so the object's type is not self-referential). */
function txClient(): unknown {
  return prisma;
}
const prisma = {
  user: {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(USERS[where.id] ? { ...USERS[where.id] } : null),
    ),
  },
  rolePermission: {
    findMany: jest.fn(({ where }: { where: { role: Role } }) =>
      Promise.resolve(
        (DEFAULT_ROLE_PERMISSIONS[where.role] ?? []).map((permission) => ({
          permission,
        })),
      ),
    ),
  },
  aiToolInvocation: {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      nextId += 1;
      const row = {
        id: `ckinvocation${String(nextId).padStart(13, '0')}`,
        conversationId: null,
        runId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      invocations.set(row.id, row);
      return Promise.resolve({ ...row });
    }),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of invocations.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    ),
    findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve({ ...invocations.get(where.id) }),
    ),
  },
  aiActionLog: {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      ledger.push(data);
      return Promise.resolve(data);
    }),
  },
  $transaction: jest.fn(
    (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(txClient()),
  ),
};

let critical: boolean;
const usersService = {
  findOne: jest.fn((id: string) =>
    USERS[id]
      ? Promise.resolve({ ...USERS[id] })
      : Promise.reject(new NotFoundException()),
  ),
  findOneSerialized: jest.fn((id: string) =>
    USERS[id]
      ? Promise.resolve({ ...USERS[id], manager: null })
      : Promise.reject(new NotFoundException()),
  ),
  offboard: jest.fn(),
};
const grantsService = {
  findAll: jest.fn(() =>
    Promise.resolve([
      {
        id: 'ckgrant000000000000000001',
        applicationId: APP_ID,
        userId: ID.target,
      },
    ]),
  ),
};
const applicationsService = {
  findOne: jest.fn((id: string) =>
    Promise.resolve({
      id,
      name: 'Payroll',
      isCritical: critical,
      deletedAt: null,
    }),
  ),
};

/** Bearer → the verified OAuth result the stubbed verifier answers (verification itself: auth spec). */
function grantFor(userId: string, scopes: OAuthScope[]) {
  return {
    ok: true as const,
    principal: { kind: 'human' as const, user: { ...USERS[userId] } },
    grant: {
      id: `ckgrant${userId.slice(-1)}${scopes.length}000000000000000`,
      clientId: 'lzc_claude',
      clientName: 'Claude Code',
      scopes,
    },
    resource: `${ISSUER}/mcp`,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}
const TOKENS: Record<string, ReturnType<typeof grantFor>> = {
  lzit_oat_admin_read: grantFor(ID.admin, ['lazyit.read']),
  lzit_oat_admin_write: grantFor(ID.admin, ['lazyit.read', 'lazyit.write']),
  lzit_oat_admin_all: grantFor(ID.admin, [
    'lazyit.read',
    'lazyit.write',
    'lazyit.admin',
  ]),
  lzit_oat_admin_adminonly: grantFor(ID.admin, ['lazyit.admin']),
  lzit_oat_member_write: grantFor(ID.member, ['lazyit.read', 'lazyit.write']),
  lzit_oat_viewer_write: grantFor(ID.viewer, ['lazyit.read', 'lazyit.write']),
};

describe('/mcp end to end — listing, calls, errors and the critical-application refusal', () => {
  const savedEnv = {
    WEB_ORIGIN: process.env.WEB_ORIGIN,
    AUTH_MODE: process.env.AUTH_MODE,
  };
  let app: INestApplication<App>;
  const notices = { noticeFirstUse: jest.fn() };

  beforeAll(async () => {
    process.env.WEB_ORIGIN = ISSUER;
    process.env.AUTH_MODE = 'local';
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController, UsersController, ApplicationsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: LocalCredentialService, useValue: {} },
        PermissionResolverService,
        PrincipalLoaderService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: MustChangePasswordGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: UsersService, useValue: usersService },
        { provide: AccessGrantsService, useValue: grantsService },
        { provide: ApplicationsService, useValue: applicationsService },
        {
          provide: AssetAssignmentsService,
          useValue: { findAll: jest.fn().mockResolvedValue([]) },
        },
        { provide: ArticlesService, useValue: {} },
        { provide: ActorService, useValue: { resolve: jest.fn() } },
        { provide: VaultSetupNudgeService, useValue: {} },
        // The AI core, real.
        AiToolDispatcher,
        AiToolRegistry,
        AiToolExecutor,
        AiActionLogService,
        AiToolService,
        { provide: AI_TOOLSETS, useValue: [usersToolset] },
        AiPromptService,
        // The MCP layer, real — except token verification.
        McpAuthGuard,
        McpServerFactory,
        McpRateLimiter,
        { provide: McpConnectionNoticeService, useValue: notices },
        {
          provide: OAuthPolicyService,
          useValue: {
            config: () => ({ issuer: ISSUER, resource: `${ISSUER}/mcp` }),
            mcpSettings: () => Promise.resolve({ mcpEnabled: true }),
          },
        },
        {
          provide: OAuthTokenService,
          useValue: {
            verifyAccessToken: (token: string) =>
              Promise.resolve(
                TOKENS[token] ?? { ok: false, reason: 'invalid', status: 401 },
              ),
          },
        },
        {
          provide: PersonalTokensService,
          useValue: { verify: jest.fn() },
        },
        {
          provide: ServiceAccountAuthenticator,
          useValue: { isServiceAccountToken: () => false },
        },
        { provide: AiRunPrincipals, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.WEB_ORIGIN = savedEnv.WEB_ORIGIN;
    process.env.AUTH_MODE = savedEnv.AUTH_MODE;
  });

  beforeEach(() => {
    invocations = new Map();
    ledger = [];
    critical = true;
    jest.clearAllMocks();
  });

  function send(rpc: McpRpc, token?: string) {
    const req = request(app.getHttpServer())
      .post('/mcp')
      .set('host', 'lazyit.example.com')
      .set(rpc.headers);
    if (token) req.set('authorization', `Bearer ${token}`);
    return req.send(rpc.body);
  }

  async function listNames(token: string): Promise<string[]> {
    const res = await send(toolsList(), token).expect(200);
    return (payloadOf(res).result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
  }

  describe('the route', () => {
    it('is @Public towards the session guards and guarded by McpAuthGuard (golden)', () => {
      const reflector = new Reflector();
      expect(reflector.get(IS_PUBLIC_KEY, McpController)).toBe(true);
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        McpController,
      ) as Type[];
      expect(guards).toEqual([McpAuthGuard]);
    });

    it('answers 401 without a token and never reaches the SDK', async () => {
      await send(toolsList()).expect(401);
      expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
    });

    it('answers GET (2025 session stream / 2026 non-POST) with 405 and mints no session id', async () => {
      const res = await request(app.getHttpServer())
        .get('/mcp')
        .set('host', 'lazyit.example.com')
        .set('authorization', 'Bearer lzit_oat_admin_read')
        .set('accept', 'text/event-stream');
      expect(res.status).toBe(405);
      expect(res.headers['mcp-session-id']).toBeUndefined();
    });
  });

  describe('listing honours the scope ceiling AND the principal’s permissions', () => {
    it.each([
      [
        'ADMIN, lazyit.read',
        'lzit_oat_admin_read',
        ['user_get', 'user_search'],
      ],
      [
        'ADMIN, read & write',
        'lzit_oat_admin_write',
        ['user_get', 'user_offboard', 'user_search'],
      ],
      [
        'ADMIN, read & write & admin',
        'lzit_oat_admin_all',
        [
          'user_create',
          'user_get',
          'user_offboard',
          'user_restore',
          'user_search',
          'user_update',
        ],
      ],
      [
        'ADMIN, lazyit.admin alone (read + elevated, never write)',
        'lzit_oat_admin_adminonly',
        [
          'user_create',
          'user_get',
          'user_restore',
          'user_search',
          'user_update',
        ],
      ],
      // MEMBER holds user:read but not user:manage: the write scope does not list user_offboard.
      [
        'MEMBER, read & write',
        'lzit_oat_member_write',
        ['user_get', 'user_search'],
      ],
      // VIEWER holds no ai:connect (and no user:read): nothing.
      ['VIEWER, read & write', 'lzit_oat_viewer_write', []],
    ])('%s', async (_label, token, expected) => {
      expect(await listNames(token)).toEqual(expected);
    });

    it('lists deterministically, with class-derived annotations, the catalog schema and a private cache hint', async () => {
      const res = await send(toolsList(), 'lzit_oat_admin_all').expect(200);
      const { result } = payloadOf(res);
      const byName = Object.fromEntries(
        (result.tools as Array<Record<string, any>>).map((t) => [t.name, t]),
      );
      expect(byName.user_get.annotations).toEqual({
        title: 'Get a user',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(byName.user_offboard.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(byName.user_create.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName.user_get.inputSchema).toMatchObject({
        type: 'object',
        required: ['user'],
      });
      expect(result).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
    });

    it('carries the domain primer as the server instructions', async () => {
      const res = await send(modern('server/discover'), 'lzit_oat_admin_read');
      expect(res.status).toBe(200);
      expect(JSON.stringify(payloadOf(res))).toContain(
        JSON.stringify(buildMcpInstructions()).slice(1, 60),
      );
    });

    it('serves a 2025-era client statelessly with the same per-caller listing', async () => {
      const res = await send(legacyToolsList(), 'lzit_oat_admin_read');
      expect(res.status).toBe(200);
      expect(
        (payloadOf(res).result.tools as Array<{ name: string }>).map(
          (t) => t.name,
        ),
      ).toEqual(['user_get', 'user_search']);
    });
  });

  describe('calls', () => {
    it('returns structuredContent and its JSON text mirror', async () => {
      const res = await send(
        toolsCall('user_get', { user: ID.target }),
        'lzit_oat_admin_read',
      ).expect(200);
      const { result } = payloadOf(res);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        ok: true,
        kind: 'read',
        mutated: false,
        data: { user: { id: ID.target } },
      });
      expect(JSON.parse(String(result.content[0].text))).toEqual(
        result.structuredContent,
      );
    });

    it('maps invalid input to isError INVALID_INPUT (core validates, not the SDK)', async () => {
      const res = await send(
        toolsCall('user_get', { nope: true }),
        'lzit_oat_admin_read',
      ).expect(200);
      expect(payloadOf(res).result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: 'INVALID_INPUT' },
        },
      });
    });

    it('maps a route 404 to isError NOT_FOUND', async () => {
      const res = await send(
        toolsCall('user_get', { user: 'aaaaaaaa-0000-4000-8000-00000000ffff' }),
        'lzit_oat_admin_read',
      ).expect(200);
      expect(payloadOf(res).result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
    });

    it('answers a tool outside the caller’s listing with a JSON-RPC error, running nothing', async () => {
      const res = await send(
        toolsCall('user_offboard', { user: ID.target }),
        'lzit_oat_admin_read',
      );
      const payload = payloadOf(res);
      expect(payload.error ?? payload.result?.isError).toBeTruthy();
      expect(usersService.offboard).not.toHaveBeenCalled();
      expect(invocations.size).toBe(0);
    });

    it('refuses a write on a critical application over MCP — through the real user_offboard, before any side effect', async () => {
      const res = await send(
        toolsCall('user_offboard', { user: ID.target }),
        'lzit_oat_admin_write',
      ).expect(200);
      const { result } = payloadOf(res);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: expect.stringContaining('critical'),
          },
        },
      });
      expect(usersService.offboard).not.toHaveBeenCalled();
      expect(applicationsService.findOne).toHaveBeenCalledWith(APP_ID);
      // The attempt is in the permanent ledger, attributed to the grant and its client.
      expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'FAILED']);
      expect(ledger[0]).toMatchObject({
        channel: 'MCP',
        toolName: 'user_offboard',
        userId: ID.admin,
        mcpClientId: 'lzc_claude',
        oauthGrantId: TOKENS.lzit_oat_admin_write.grant.id,
      });
      expect([...invocations.values()][0]).toMatchObject({
        channel: 'MCP',
        status: 'FAILED',
        errorCode: 'FORBIDDEN',
      });
    });
  });
});
