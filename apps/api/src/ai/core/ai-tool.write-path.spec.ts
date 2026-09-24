import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';
import {
  AiToolResultSchema,
  type AiActionPreview,
  type Permission,
  type Role,
} from '@lazyit/shared';

jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
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

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { MustChangePasswordGuard } from '../../auth/must-change-password.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { ServiceAccountAuthenticator } from '../../auth/service-account-authenticator';
import { LocalCredentialService } from '../../auth/local/local-credential.service';
import { RequirePermission } from '../../auth/require-permission.decorator';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetHistoryService } from '../../asset-history/asset-history.service';
import { UserHistoryService } from '../../user-history/user-history.service';
import { AiActionLogService } from './action-log.service';
import { AiToolService } from './ai-tool.service';
import { AI_SETTINGS_READER } from './ports/ai-settings.port';
import { REDACTED } from './redaction';
import { AiToolDispatcher } from './tool-dispatcher';
import { AiToolExecutor } from './tool-executor';
import {
  bind,
  defineTool,
  type AiExecutionContext,
  type AiToolset,
} from './tool-descriptor';
import { AI_TOOLSETS, AiToolRegistry } from './tool-registry';

/**
 * The ledger-backed WRITE PATH of the AI core (tools-and-execution.md §8.4, §9, §10; INV-AI-3,
 * INV-AI-10), end to end through the real Nest guard and pipe pipeline:
 *   - MCP and headless writes execute and leave `ATTEMPTED` → `EXECUTED` | `FAILED` | `DENIED`;
 *   - a chat write is refused by `invoke`, proposed with a server-built preview, and executed only by
 *     its owner's approval — once, before expiry, re-authorized and version-checked;
 *   - the history rows an AI mutation writes carry its `aiInvocationId`.
 *
 * No shipped tool writes yet, so a test-only toolset binds a fixture controller. The Prisma client is an
 * in-memory fake whose `updateMany` applies the same conditional `where` the database would.
 */

// ─── Principals ──────────────────────────────────────────────────────────────────────────────────

const ID = {
  member: 'aaaaaaaa-0000-4000-8000-000000000002',
  other: 'aaaaaaaa-0000-4000-8000-000000000006',
  viewer: 'aaaaaaaa-0000-4000-8000-000000000003',
};
const SA = {
  writer: 'ckwritersa0000000000000001',
  noAi: 'cknoaisa00000000000000002',
  legacy: 'cklegacysa0000000000000003',
};

const ROLE_GRANTS: Record<Role, Permission[]> = {
  ADMIN: [],
  MEMBER: ['ai:use', 'ai:connect', 'asset:read', 'asset:write'],
  VIEWER: ['ai:use', 'ai:connect', 'asset:read'],
};
const SA_GRANTS: Record<string, Permission[]> = {
  [SA.writer]: ['ai:use', 'asset:read', 'asset:write'],
  [SA.noAi]: ['asset:read', 'asset:write'],
  // SEC-073: `user:manage` granted before SEC-011 and never re-saved — must be inert at principal load.
  [SA.legacy]: ['ai:use', 'asset:read', 'asset:write', 'user:manage'],
};

type UserRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  isActive: boolean;
  directoryOnly: boolean;
  mustChangePassword: boolean;
  sessionEpoch: number;
  deletedAt: null;
};
let users: Record<string, UserRow>;

function user(id: string, role: Role): UserRow {
  return {
    id,
    email: `${id}@example.com`,
    firstName: role,
    lastName: 'User',
    role,
    isActive: true,
    directoryOnly: false,
    mustChangePassword: false,
    sessionEpoch: 1,
    deletedAt: null,
  };
}

const human = (userId: string): DelegatedIdentity => ({
  kind: 'human',
  userId,
  sessionEpoch: 1,
});
const service = (serviceAccountId: string): DelegatedIdentity => ({
  kind: 'service',
  serviceAccountId,
});

// ─── A fixture domain: things with a version, whose update writes asset and user history ──────────

type Thing = { id: string; name: string; updatedAt: string };
let things: Record<string, Thing>;
const historyWriter = {
  assetHistory: { create: jest.fn().mockResolvedValue({}) },
  userHistory: { create: jest.fn().mockResolvedValue({}) },
};
let updates: number;

class UpdateThingDto extends createZodDto(
  z.strictObject({ name: z.string().min(1) }),
) {}

@Controller('fixture-things')
class ThingsController {
  constructor(
    private readonly assetHistory: AssetHistoryService,
    private readonly userHistory: UserHistoryService,
  ) {}

  @Get(':id')
  @RequirePermission('asset:read')
  get(@Param('id') id: string): Thing {
    const thing = things[id];
    if (!thing) throw new NotFoundException('Thing not found');
    return { ...thing };
  }

  @Patch(':id')
  @RequirePermission('asset:write')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateThingDto,
  ): Promise<Thing> {
    const thing = things[id];
    if (!thing) throw new NotFoundException('Thing not found');
    if (dto.name === 'taken') throw new ConflictException('Name taken');
    if (dto.name === 'crash') throw new Error('pg: password=hunter2 leaked');
    updates += 1;
    things[id] = {
      ...thing,
      name: dto.name,
      updatedAt: new Date(Date.parse(thing.updatedAt) + 1000).toISOString(),
    };
    await this.assetHistory.record(historyWriter, {
      assetId: id,
      eventType: 'UPDATED',
    });
    await this.userHistory.record(historyWriter, {
      userId: ID.member,
      eventType: 'UPDATED',
    });
    return { ...things[id] };
  }

  /** A `user:manage` write (the shape of `POST /users` with `role: ADMIN`), for SEC-073. */
  @Patch(':id/admin')
  @RequirePermission('user:manage')
  makeAdmin(@Param('id') id: string): Thing {
    const thing = things[id];
    if (!thing) throw new NotFoundException('Thing not found');
    updates += 1;
    return { ...thing };
  }
}

const thingInput = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Not sent to the route: only here to prove the ledger redacts a credential-looking field. */
  apiToken: z.string().optional(),
});

const writeToolset: AiToolset = {
  domain: 'platform',
  tools: [
    defineTool({
      name: 'thing_rename',
      title: 'Rename a thing',
      description: 'Renames a fixture thing.',
      domain: 'platform',
      class: 'write',
      input: thingInput,
      bindings: [
        bind(ThingsController, 'update'),
        bind(ThingsController, 'get'),
      ],
      async run(input, rt) {
        const thing = await rt.call(ThingsController, 'update', {
          params: { id: input.id },
          body: { name: input.name },
        });
        return {
          data: thing,
          entityRefs: [
            { type: 'asset', id: thing.id, op: 'updated', label: thing.name },
          ],
        };
      },
      async preview(input, rt) {
        const current = await rt.call(ThingsController, 'get', {
          params: { id: input.id },
        });
        const target = {
          type: 'asset' as const,
          id: current.id,
          op: 'updated' as const,
          label: current.name,
        };
        return {
          target,
          changes: [{ field: 'name', before: current.name, after: input.name }],
          warnings: [],
          impacted: [],
          untrustedSources: [],
          elevated: false,
          stepUpRequired: false,
          precondition: { entity: target, updatedAt: current.updatedAt },
        };
      },
    }),
    defineTool({
      name: 'thing_promote',
      title: 'Promote a thing',
      description: 'An elevated fixture write that needs a password step-up.',
      domain: 'platform',
      class: 'elevated',
      input: thingInput,
      bindings: [bind(ThingsController, 'update')],
      async run(input, rt) {
        return {
          data: await rt.call(ThingsController, 'update', {
            params: { id: input.id },
            body: { name: input.name },
          }),
        };
      },
      preview: () =>
        Promise.resolve({
          changes: [],
          warnings: ['ROLE_CHANGE'],
          impacted: [],
          untrustedSources: [],
          elevated: true,
          stepUpRequired: true,
        }),
    }),
    defineTool({
      name: 'thing_make_admin',
      title: 'Make a thing an admin',
      description: 'An elevated fixture write gated by user:manage (SEC-073).',
      domain: 'platform',
      class: 'elevated',
      input: z.strictObject({ id: z.string().min(1) }),
      bindings: [bind(ThingsController, 'makeAdmin')],
      async run(input, rt) {
        return {
          data: await rt.call(ThingsController, 'makeAdmin', {
            params: { id: input.id },
          }),
        };
      },
      preview: () =>
        Promise.resolve({
          changes: [],
          warnings: ['ROLE_CHANGE'],
          impacted: [],
          untrustedSources: [],
          elevated: true,
          stepUpRequired: true,
        }),
    }),
    // Elevated tools whose previews do NOT ask for step-up: core derives it from the warnings.
    previewFixture('thing_set_role', 'elevated', {
      warnings: ['ROLE_CHANGE'],
      elevated: true,
    }),
    previewFixture('thing_set_email', 'elevated', {
      warnings: ['IDENTITY_CHANGE'],
      elevated: true,
    }),
    previewFixture('thing_grant', 'elevated', {
      warnings: ['PRIVILEGE_GRANT', 'EXTERNAL_PROVISIONING'],
      elevated: true,
    }),
    previewFixture('thing_send_invite', 'elevated', {
      warnings: ['CREDENTIAL_DELIVERY'],
      elevated: true,
    }),
    previewFixture('thing_notify', 'elevated', {
      warnings: ['NOTIFIES_USERS'],
      elevated: true,
    }),
    // ADR-0097 decision 3 as amended 2026-09-24: a workflow write on a critical application needs step-up,
    // an outbound integration on a non-critical one does not.
    previewFixture('thing_enable_critical_workflow', 'elevated', {
      warnings: ['OUTBOUND_INTEGRATION', 'CRITICAL_APPLICATION'],
      elevated: true,
    }),
    previewFixture('thing_create_outbound', 'elevated', {
      warnings: ['OUTBOUND_INTEGRATION'],
      elevated: true,
    }),
    // A `write`-class tool (like an access revoke) on a critical application: step-up without escalating.
    previewFixture('thing_revoke_critical', 'write', {
      warnings: ['EXTERNAL_DEPROVISIONING', 'CRITICAL_APPLICATION'],
    }),
    previewFixture('thing_unclassified', 'elevated', {
      warnings: [],
      elevated: true,
    }),
    // Tool bugs core must refuse at propose.
    previewFixture('thing_bad_preview', 'write', {
      warnings: 'not-a-list' as unknown as string[],
    }),
    previewFixture('thing_no_precondition', 'write', {
      target: { type: 'asset', id: 't1', op: 'updated' },
    }),
  ],
  unexposed: [],
};

/** A fixture write whose run renames `t1` and whose preview is exactly `preview` (defaults: no warning). */
function previewFixture(
  name: string,
  toolClass: 'write' | 'elevated',
  preview: Partial<AiActionPreview>,
) {
  return defineTool({
    name,
    title: name,
    description: `Fixture ${name}.`,
    domain: 'platform',
    class: toolClass,
    input: thingInput,
    bindings: [bind(ThingsController, 'update')],
    async run(input, rt) {
      return {
        data: await rt.call(ThingsController, 'update', {
          params: { id: input.id },
          body: { name: input.name },
        }),
      };
    },
    preview: () =>
      Promise.resolve({
        changes: [],
        warnings: [],
        impacted: [],
        untrustedSources: [],
        elevated: false,
        stepUpRequired: false,
        ...preview,
      }),
  });
}

// ─── An in-memory Prisma for the two AI tables ───────────────────────────────────────────────────────

type InvocationRow = Record<string, unknown> & { id: string };
let invocations: Map<string, InvocationRow>;
let ledger: Array<Record<string, unknown>>;
let nextId: number;

type Where = Record<string, unknown>;
function matches(row: InvocationRow, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { gt?: Date; lte?: Date };
      if (c.gt !== undefined)
        return value instanceof Date && value.getTime() > c.gt.getTime();
      if (c.lte !== undefined)
        return value instanceof Date && value.getTime() <= c.lte.getTime();
      return false;
    }
    return value === cond;
  });
}

const aiToolInvocation = {
  create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
    nextId += 1;
    const now = new Date();
    const row: InvocationRow = {
      id: `ckinvocation${String(nextId).padStart(13, '0')}`,
      conversationId: null,
      runId: null,
      toolUseId: null,
      mcpClientId: null,
      oauthGrantId: null,
      preview: null,
      precondition: null,
      expiresAt: null,
      decidedAt: null,
      result: null,
      entityRefs: null,
      errorCode: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    };
    invocations.set(row.id, row);
    return Promise.resolve({ ...row });
  }),
  updateMany: jest.fn(
    ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of invocations.values()) {
        if (matches(row, where)) {
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  ),
  findUnique: jest.fn(({ where }: { where: { id: string } }) => {
    const row = invocations.get(where.id);
    return Promise.resolve(row ? { ...row } : null);
  }),
  findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => {
    const row = invocations.get(where.id);
    return row
      ? Promise.resolve({ ...row })
      : Promise.reject(new Error('not found'));
  }),
  findMany: jest.fn(({ where, take }: { where: Where; take?: number }) =>
    Promise.resolve(
      [...invocations.values()]
        .filter((row) => matches(row, where))
        .slice(0, take)
        .map((row) => ({ id: row.id })),
    ),
  ),
};

const aiActionLog = {
  create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
    ledger.push(data);
    return Promise.resolve(data);
  }),
  // Present only to prove the app never calls them (INV-AI-10).
  update: jest.fn(),
  updateMany: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
};

const prisma = {
  user: {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(users[where.id] ? { ...users[where.id] } : null),
    ),
  },
  serviceAccount: {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        SA_GRANTS[where.id]
          ? {
              id: where.id,
              name: where.id,
              isActive: true,
              expiresAt: null,
              deletedAt: null,
            }
          : null,
      ),
    ),
    update: jest.fn().mockResolvedValue({}),
  },
  serviceAccountPermission: {
    findMany: jest.fn(({ where }: { where: { serviceAccountId: string } }) =>
      Promise.resolve(
        (SA_GRANTS[where.serviceAccountId] ?? []).map((permission) => ({
          permission,
        })),
      ),
    ),
  },
  rolePermission: {
    findMany: jest.fn(({ where }: { where: { role: Role } }) =>
      Promise.resolve(
        ROLE_GRANTS[where.role].map((permission) => ({ permission })),
      ),
    ),
  },
  aiToolInvocation,
  aiActionLog,
  /** An interactive transaction: all or nothing over the in-memory tables. */
  $transaction: jest.fn(
    async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = new Map(
        [...invocations].map(([id, row]) => [id, { ...row }]),
      );
      const ledgerLength = ledger.length;
      try {
        return await fn(prisma);
      } catch (err) {
        invocations = snapshot;
        ledger.splice(ledgerLength);
        throw err;
      }
    },
  ),
};

/** An MCP token holding `lazyit.read` + `lazyit.write` (R7). */
const WRITE_SCOPE = ['read', 'write'] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────

const events = (invocationId: string) =>
  ledger.filter((e) => e.invocationId === invocationId).map((e) => e.event);

function chat(
  identity: DelegatedIdentity,
  extra: Partial<AiExecutionContext> = {},
): AiExecutionContext {
  return {
    identity,
    channel: 'CHAT',
    conversationId: 'ckconversation000000000001',
    runId: 'ckrun0000000000000000000001',
    ...extra,
  };
}

describe('AiToolService — the ledger-backed write path (INV-AI-3, INV-AI-10)', () => {
  const originalMode = process.env.AUTH_MODE;
  let app: INestApplication;
  let tools: AiToolService;
  let dispatcher: AiToolDispatcher;
  let ttlMinutes: number | undefined;

  beforeAll(async () => {
    process.env.AUTH_MODE = 'local';
    const moduleRef = await Test.createTestingModule({
      controllers: [ThingsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: LocalCredentialService, useValue: {} },
        PermissionResolverService,
        PrincipalLoaderService,
        ServiceAccountAuthenticator,
        AssetHistoryService,
        UserHistoryService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: MustChangePasswordGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
          provide: AI_SETTINGS_READER,
          useValue: {
            getSettings: () =>
              ttlMinutes === undefined
                ? Promise.reject(new Error('settings unavailable'))
                : Promise.resolve({ approvalTtlMinutes: ttlMinutes }),
          },
        },
        AiToolDispatcher,
        AiToolRegistry,
        AiToolExecutor,
        AiActionLogService,
        AiToolService,
        { provide: AI_TOOLSETS, useValue: [writeToolset] },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tools = app.get(AiToolService);
    dispatcher = app.get(AiToolDispatcher);
  });

  afterAll(async () => {
    await app.close();
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(() => {
    users = {
      [ID.member]: user(ID.member, 'MEMBER'),
      [ID.other]: user(ID.other, 'MEMBER'),
      [ID.viewer]: user(ID.viewer, 'VIEWER'),
    };
    things = {
      t1: { id: 't1', name: 'Laptop', updatedAt: '2026-09-01T00:00:00.000Z' },
    };
    invocations = new Map();
    ledger = [];
    nextId = 0;
    updates = 0;
    ttlMinutes = undefined;
    jest.clearAllMocks();
  });

  // ─── MCP and headless ─────────────────────────────────────────────────────────────────────────────

  describe('invoke — MCP and headless writes', () => {
    it('executes for an authorized principal and logs exactly ATTEMPTED → EXECUTED', async () => {
      for (const [identity, channel] of [
        [human(ID.member), 'MCP'],
        [service(SA.writer), 'HEADLESS'],
      ] as const) {
        ledger = [];
        const result = await tools.invoke(
          'thing_rename',
          { id: 't1', name: `Renamed via ${channel}` },
          {
            identity,
            channel,
            ...(channel === 'MCP'
              ? {
                  mcp: { grantId: 'grant1', clientId: 'client1' },
                  ceiling: WRITE_SCOPE,
                }
              : { runId: 'ckheadlessrun00000000000001' }),
            provenance: { provider: 'anthropic', model: 'm1', requestId: 'r1' },
          },
        );
        expect(AiToolResultSchema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
          ok: true,
          kind: 'mutation',
          mutated: true,
        });
        const [row] = [...invocations.values()].slice(-1);
        expect(row).toMatchObject({ status: 'SUCCEEDED', channel });
        expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'EXECUTED']);
        const executed = ledger[1];
        expect(executed).toMatchObject({
          invocationId: row.id,
          channel,
          toolName: 'thing_rename',
          toolClass: 'write',
          provider: 'anthropic',
          model: 'm1',
          requestId: 'r1',
          errorCode: null,
        });
        if (identity.kind === 'human') {
          expect(executed).toMatchObject({
            userId: ID.member,
            serviceAccountId: null,
            mcpClientId: 'client1',
            oauthGrantId: 'grant1',
          });
        } else {
          expect(executed).toMatchObject({
            userId: null,
            serviceAccountId: SA.writer,
          });
        }
        expect(executed.entityRefs).toEqual([
          {
            type: 'asset',
            id: 't1',
            op: 'updated',
            label: `Renamed via ${channel}`,
          },
        ]);
      }
      expect(updates).toBe(2);
    });

    it('stamps the invocation id on the asset and user history rows the mutation writes', async () => {
      await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'Stamped' },
        { identity: service(SA.writer), channel: 'HEADLESS' },
      );
      const [row] = [...invocations.values()];
      const assetRow = (
        historyWriter.assetHistory.create.mock.calls as Array<
          [{ data: Record<string, unknown> }]
        >
      )[0][0].data;
      const userRow = (
        historyWriter.userHistory.create.mock.calls as Array<
          [{ data: Record<string, unknown> }]
        >
      )[0][0].data;
      expect(assetRow.aiInvocationId).toBe(row.id);
      expect(userRow.aiInvocationId).toBe(row.id);
      expect(ledger[0].invocationId).toBe(row.id);
    });

    it('logs a failure as FAILED with the mapped error, once, and never retries', async () => {
      const spy = jest.spyOn(dispatcher, 'dispatch');
      const conflict = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'taken' },
        { identity: human(ID.member), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(conflict).toMatchObject({
        ok: false,
        mutated: false,
        error: { code: 'CONFLICT', status: 409 },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const crash = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'crash' },
        { identity: human(ID.member), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(crash).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
      expect(ledger.map((e) => [e.event, e.errorCode, e.errorStatus])).toEqual([
        ['ATTEMPTED', null, null],
        ['FAILED', 'CONFLICT', 409],
        ['ATTEMPTED', null, null],
        ['FAILED', 'INTERNAL', 500],
      ]);
      // A 5xx never exposes its message — not to the model, not in the ledger.
      expect(JSON.stringify(ledger)).not.toContain('hunter2');
      expect([...invocations.values()].map((r) => r.status)).toEqual([
        'FAILED',
        'FAILED',
      ]);
    });

    it('lets the route refuse what it refuses: a VIEWER without asset:write fails FORBIDDEN', async () => {
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: human(ID.viewer), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
      expect(updates).toBe(0);
      expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'FAILED']);
    });

    it('records the AI-level refusals as ATTEMPTED → DENIED without dispatching', async () => {
      const spy = jest.spyOn(dispatcher, 'dispatch');
      const outsideCeiling = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: human(ID.member), channel: 'MCP', ceiling: ['read'] },
      );
      const noGate = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: service(SA.noAi), channel: 'HEADLESS' },
      );
      for (const result of [outsideCeiling, noGate]) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'FORBIDDEN', status: 403 },
        });
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(ledger.map((e) => e.event)).toEqual([
        'ATTEMPTED',
        'DENIED',
        'ATTEMPTED',
        'DENIED',
      ]);
      expect([...invocations.values()].map((r) => r.status)).toEqual([
        'DENIED',
        'DENIED',
      ]);
    });

    it('refuses a headless user:manage write by an SA holding only a legacy (pre-SEC-011) grant (SEC-073)', async () => {
      const result = await tools.invoke(
        'thing_make_admin',
        { id: 't1' },
        {
          identity: service(SA.legacy),
          channel: 'HEADLESS',
          runId: 'ckheadlessrun00000000000002',
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
      expect(updates).toBe(0);
      // The same SA still runs a grantable headless write: only the ungrantable verb was stripped.
      const allowed = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'Still works' },
        { identity: service(SA.legacy), channel: 'HEADLESS' },
      );
      expect(allowed).toMatchObject({ ok: true, mutated: true });
    });

    it('writes nothing for an invalid input or an invalid principal (nothing was attempted)', async () => {
      const invalid = await tools.invoke(
        'thing_rename',
        { id: 't1' },
        { identity: human(ID.member), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(invalid).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      const stale = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        {
          identity: { kind: 'human', userId: ID.member, sessionEpoch: 99 },
          channel: 'MCP',
        },
      );
      expect(stale).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 401 },
      });
      expect(ledger).toEqual([]);
      expect(invocations.size).toBe(0);
    });

    it('does not execute a write the ledger could not record (write-ahead)', async () => {
      aiActionLog.create.mockRejectedValueOnce(new Error('db down'));
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: human(ID.member), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect(updates).toBe(0);
    });

    it('redacts credential-looking input fields in the ledger (the invocation keeps the canonical input)', async () => {
      await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x', apiToken: 'lzit_sa_supersecret' },
        { identity: human(ID.member), channel: 'MCP', ceiling: WRITE_SCOPE },
      );
      expect(ledger[0].input).toEqual({
        id: 't1',
        name: 'x',
        apiToken: REDACTED,
      });
      expect(JSON.stringify(ledger)).not.toContain('supersecret');
    });
  });

  // ─── Chat: propose, approve, reject ───────────────────────────────────────────────────────────────

  describe('chat writes — propose and approve', () => {
    async function propose(
      identity: DelegatedIdentity = human(ID.member),
      name = 'thing_rename',
      input: unknown = { id: 't1', name: 'Renamed' },
    ) {
      const proposal = await tools.propose(name, input, chat(identity), {
        toolUseId: 'toolu_1',
      });
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.result));
      return proposal.action;
    }

    it('invoke refuses a chat write without dispatching or recording anything', async () => {
      const spy = jest.spyOn(dispatcher, 'dispatch');
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        chat(human(ID.member)),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'NOT_AVAILABLE' },
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(ledger).toEqual([]);
    });

    it('propose stores a pending action with the server-built preview and writes PROPOSED only', async () => {
      const before = Date.now();
      const action = await propose();
      expect(action).toMatchObject({
        status: 'AWAITING_APPROVAL',
        toolName: 'thing_rename',
        toolUseId: 'toolu_1',
        preview: {
          toolName: 'thing_rename',
          class: 'write',
          target: { type: 'asset', id: 't1', label: 'Laptop' },
          changes: [{ field: 'name', before: 'Laptop', after: 'Renamed' }],
          precondition: { updatedAt: '2026-09-01T00:00:00.000Z' },
        },
      });
      // The default 30-minute expiry when the settings port is unavailable.
      const ttl = action.expiresAt!.getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 1000);
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED']);
      const row = invocations.get(action.id)!;
      expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof row.schemaHash).toBe('string');
    });

    it('reads the expiry from the settings port when it is bound', async () => {
      ttlMinutes = 5;
      const before = Date.now();
      const action = await propose();
      const ttl = action.expiresAt!.getTime() - before;
      expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 1000);
      expect(ttl).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    });

    it('merges the turn’s untrusted sources into the stored preview', async () => {
      const source = {
        type: 'article' as const,
        id: 'kb1',
        op: 'navigate' as const,
      };
      const proposal = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'x' },
        chat(human(ID.member), { untrustedSources: [source] }),
      );
      expect(proposal).toMatchObject({
        ok: true,
        action: { preview: { untrustedSources: [source] } },
      });
    });

    it('refuses to propose what the route would refuse, recording DENIED — no card is shown', async () => {
      const proposal = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'x' },
        chat(human(ID.viewer)),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'FORBIDDEN', status: 403 } },
      });
      expect(ledger.map((e) => e.event)).toEqual(['DENIED']);
    });

    it('refuses to propose over MCP or as a Service Account', async () => {
      for (const ctx of [
        { identity: human(ID.member), channel: 'MCP' as const },
        { identity: service(SA.writer), channel: 'CHAT' as const },
      ]) {
        const proposal = await tools.propose(
          'thing_rename',
          { id: 't1', name: 'x' },
          ctx,
        );
        expect(proposal).toMatchObject({
          ok: false,
          result: { error: { code: 'NOT_AVAILABLE' } },
        });
      }
      expect(invocations.size).toBe(0);
    });

    it('answers a preview failure (missing target) without storing anything', async () => {
      const proposal = await tools.propose(
        'thing_rename',
        { id: 'nope', name: 'x' },
        chat(human(ID.member)),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'NOT_FOUND' } },
      });
      expect(invocations.size).toBe(0);
    });

    it('approve by the owner executes once: PROPOSED → APPROVED → EXECUTED, history stamped', async () => {
      const action = await propose();
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'SUCCEEDED',
        result: { ok: true, mutated: true },
      });
      expect(approved.decidedAt).toBeInstanceOf(Date);
      expect(updates).toBe(1);
      expect(things.t1.name).toBe('Renamed');
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTED']);
      const approvedEvent = ledger.find((e) => e.event === 'APPROVED')!;
      expect(approvedEvent).toMatchObject({
        approverUserId: ID.member,
        stepUp: false,
        userId: ID.member,
        channel: 'CHAT',
        conversationId: 'ckconversation000000000001',
        runId: 'ckrun0000000000000000000001',
      });
      const assetRow = (
        historyWriter.assetHistory.create.mock.calls as Array<
          [{ data: Record<string, unknown> }]
        >
      )[0][0].data;
      expect(assetRow.aiInvocationId).toBe(action.id);
    });

    it('a second approve executes nothing and replays the stored outcome', async () => {
      const action = await propose();
      await tools.approve(action.id, chat(human(ID.member)));
      const again = await tools.approve(action.id, chat(human(ID.member)));
      expect(again).toMatchObject({ status: 'SUCCEEDED', replayed: true });
      expect(updates).toBe(1);
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTED']);
    });

    it('concurrent approvals execute exactly once', async () => {
      const action = await propose();
      const outcomes = await Promise.allSettled([
        tools.approve(action.id, chat(human(ID.member))),
        tools.approve(action.id, chat(human(ID.member))),
        tools.approve(action.id, chat(human(ID.member))),
      ]);
      expect(updates).toBe(1);
      expect(
        events(action.id).filter((e) => e === 'EXECUTED' || e === 'APPROVED'),
      ).toEqual(['APPROVED', 'EXECUTED']);
      // The losers were refused (in progress) or replayed — never executed.
      expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    });

    it('refuses a non-owner as not found, without executing', async () => {
      const action = await propose();
      await expect(
        tools.approve(action.id, chat(human(ID.other))),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        tools.reject(action.id, chat(human(ID.other))),
      ).rejects.toMatchObject({ status: 404 });
      expect(updates).toBe(0);
      expect(invocations.get(action.id)!.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses an approval from another run of the same user as not found', async () => {
      const action = await propose();
      await expect(
        tools.approve(
          action.id,
          chat(human(ID.member), { runId: 'ckotherrun0000000000000001' }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(updates).toBe(0);
    });

    it('refuses a Service Account, an MCP grant or a non-chat channel — only a human session decides', async () => {
      const action = await propose();
      for (const ctx of [
        chat(service(SA.writer)),
        chat(human(ID.member), { mcp: { grantId: 'g', clientId: 'c' } }),
        { identity: human(ID.member), channel: 'HEADLESS' as const },
        { identity: human(ID.member), channel: 'MCP' as const },
      ]) {
        await expect(tools.approve(action.id, ctx)).rejects.toMatchObject({
          status: 403,
        });
      }
      expect(updates).toBe(0);
      expect(invocations.get(action.id)!.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses an expired action and marks it EXPIRED', async () => {
      const action = await propose();
      invocations.get(action.id)!.expiresAt = new Date(Date.now() - 1000);
      await expect(
        tools.approve(action.id, chat(human(ID.member))),
      ).rejects.toMatchObject({ status: 409 });
      expect(updates).toBe(0);
      expect(invocations.get(action.id)!.status).toBe('EXPIRED');
      expect(events(action.id)).toEqual(['PROPOSED', 'EXPIRED']);
    });

    it('re-authorizes at execute: a permission revoked after the proposal fails FORBIDDEN', async () => {
      const action = await propose();
      users[ID.member].role = 'VIEWER';
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { ok: false, error: { code: 'FORBIDDEN' } },
      });
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
    });

    it('re-checks the principal at execute: a signed-out session cannot approve', async () => {
      const action = await propose();
      users[ID.member].sessionEpoch = 2;
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { error: { code: 'FORBIDDEN', status: 401 } },
      });
      expect(updates).toBe(0);
    });

    it('refuses a target changed since the preview as STALE', async () => {
      const action = await propose();
      things.t1 = { ...things.t1, updatedAt: '2026-09-02T00:00:00.000Z' };
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { ok: false, error: { code: 'STALE', status: 409 } },
      });
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
      expect(ledger.at(-1)).toMatchObject({ errorCode: 'STALE' });
    });

    it('expires an action whose tool changed shape since it was proposed', async () => {
      const action = await propose();
      invocations.get(action.id)!.schemaHash = 'an-older-schema';
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'EXPIRED',
        result: { error: { code: 'EXPIRED' } },
      });
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXPIRED']);
    });

    it('refuses an elevated step-up action without the step-up, leaving it pending; records the flag with it', async () => {
      const action = await propose(human(ID.member), 'thing_promote');
      expect(action.preview).toMatchObject({
        elevated: true,
        stepUpRequired: true,
      });
      await expect(
        tools.approve(action.id, chat(human(ID.member))),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'STEP_UP_REQUIRED' },
      });
      expect(invocations.get(action.id)!.status).toBe('AWAITING_APPROVAL');
      expect(updates).toBe(0);

      const approved = await tools.approve(action.id, chat(human(ID.member)), {
        stepUpVerified: true,
      });
      expect(approved.status).toBe('SUCCEEDED');
      expect(updates).toBe(1);
      expect(
        ledger
          .filter((e) => e.invocationId === action.id)
          .map((e) => [e.event, e.stepUp]),
      ).toEqual([
        ['PROPOSED', false],
        ['APPROVED', true],
        ['EXECUTED', true],
      ]);
    });

    it('reject by the owner records REJECTED, tells the model, and cannot then be approved', async () => {
      const action = await propose();
      const rejected = await tools.reject(
        action.id,
        chat(human(ID.member)),
        'wrong laptop',
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        result: { ok: false },
      });
      expect(JSON.stringify(rejected.result)).toContain('wrong laptop');
      await expect(
        tools.approve(action.id, chat(human(ID.member))),
      ).rejects.toMatchObject({ status: 409 });
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED', 'REJECTED']);
    });
  });

  // ─── The runtime's primitives ─────────────────────────────────────────────────────────────────────

  describe('lifecycle primitives for the runtime', () => {
    it('expireDue expires only past-due pending actions, once', async () => {
      const due = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'a' },
        chat(human(ID.member)),
      );
      const fresh = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'b' },
        chat(human(ID.member)),
      );
      if (!due.ok || !fresh.ok) throw new Error('proposal failed');
      invocations.get(due.action.id)!.expiresAt = new Date(Date.now() - 1);
      const expired = await tools.expireDue();
      expect(expired.map((a) => a.id)).toEqual([due.action.id]);
      expect(await tools.expireDue()).toEqual([]);
      expect(events(due.action.id)).toEqual(['PROPOSED', 'EXPIRED']);
      expect(events(fresh.action.id)).toEqual(['PROPOSED']);
    });

    it('cancel closes a pending action with CANCELLED; a decided one is left alone', async () => {
      const proposal = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'a' },
        chat(human(ID.member)),
      );
      if (!proposal.ok) throw new Error('proposal failed');
      const cancelled = await tools.cancel(proposal.action.id);
      expect(cancelled?.status).toBe('CANCELLED');
      expect(await tools.cancel(proposal.action.id)).toBeNull();
      expect(events(proposal.action.id)).toEqual(['PROPOSED', 'CANCELLED']);
    });

    it('markOutcomeUnknown finalizes an interrupted execution without retrying it', async () => {
      const proposal = await tools.propose(
        'thing_rename',
        { id: 't1', name: 'a' },
        chat(human(ID.member)),
      );
      if (!proposal.ok) throw new Error('proposal failed');
      expect(await tools.markOutcomeUnknown(proposal.action.id)).toBeNull();
      invocations.get(proposal.action.id)!.status = 'EXECUTING';
      const unknown = await tools.markOutcomeUnknown(proposal.action.id);
      expect(unknown).toMatchObject({
        status: 'OUTCOME_UNKNOWN',
        result: { error: { code: 'UNKNOWN_OUTCOME' } },
      });
      expect(ledger.at(-1)).toMatchObject({
        event: 'FAILED',
        errorCode: 'UNKNOWN_OUTCOME',
      });
      expect(updates).toBe(0);
    });
  });

  // ─── Review fixes (#1337) ─────────────────────────────────────────────────────────────────────────

  describe('review fixes', () => {
    async function proposeOk(
      name: string,
      input: unknown = { id: 't1', name: 'x' },
    ) {
      const proposal = await tools.propose(name, input, chat(human(ID.member)));
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.result));
      return proposal.action;
    }

    it('refuses a HEADLESS write by a human (headless is the Service Account API) as DENIED', async () => {
      const spy = jest.spyOn(dispatcher, 'dispatch');
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: human(ID.member), channel: 'HEADLESS' },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN', status: 403 },
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'DENIED']);
    });

    it('fails an MCP call with no ceiling closed to read: writes are denied and not listed', async () => {
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: human(ID.member), channel: 'MCP' },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(updates).toBe(0);
      expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'DENIED']);
      const listed = await tools.list({
        identity: human(ID.member),
        channel: 'MCP',
      });
      expect(listed).toEqual([]);
      const scoped = await tools.list({
        identity: human(ID.member),
        channel: 'MCP',
        ceiling: WRITE_SCOPE,
      });
      expect(scoped.map((t) => t.name)).toContain('thing_rename');
    });

    it('refuses a preview that does not parse, storing nothing', async () => {
      const proposal = await tools.propose(
        'thing_bad_preview',
        { id: 't1', name: 'x' },
        chat(human(ID.member)),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'INTERNAL' } },
      });
      expect(invocations.size).toBe(0);
    });

    it('refuses a preview with a target but no precondition', async () => {
      const proposal = await tools.propose(
        'thing_no_precondition',
        { id: 't1', name: 'x' },
        chat(human(ID.member)),
      );
      expect(proposal).toMatchObject({
        ok: false,
        result: { error: { code: 'INTERNAL' } },
      });
      expect(invocations.size).toBe(0);
    });

    it('fails closed at approve when the stored preview is unreadable', async () => {
      const action = await proposeOk('thing_rename');
      invocations.get(action.id)!.preview = { garbage: true };
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { error: { code: 'INTERNAL' } },
      });
      expect(updates).toBe(0);
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
    });

    it('refuses to execute a stored input that no longer matches its hash, and ledgers it', async () => {
      const action = await proposeOk('thing_rename');
      invocations.get(action.id)!.input = { id: 't1', name: 'Tampered' };
      const approved = await tools.approve(action.id, chat(human(ID.member)));
      expect(approved).toMatchObject({
        status: 'FAILED',
        result: { error: { code: 'INTERNAL' } },
      });
      expect(updates).toBe(0);
      expect(things.t1.name).toBe('Laptop');
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
    });

    it('stores no approvable row when the PROPOSED event cannot be written (atomic)', async () => {
      aiActionLog.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        tools.propose(
          'thing_rename',
          { id: 't1', name: 'x' },
          chat(human(ID.member)),
        ),
      ).rejects.toThrow('db down');
      expect(invocations.size).toBe(0);
      expect(ledger).toEqual([]);
    });

    it('does not execute when the APPROVED event cannot be written, and closes the claim FAILED', async () => {
      const action = await proposeOk('thing_rename');
      aiActionLog.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        tools.approve(action.id, chat(human(ID.member))),
      ).rejects.toThrow('db down');
      expect(updates).toBe(0);
      expect(invocations.get(action.id)).toMatchObject({
        status: 'FAILED',
        errorCode: 'INTERNAL',
      });
      expect(events(action.id)).toEqual(['PROPOSED']);
    });

    it('still appends the outcome to the ledger when the invocation row cannot be updated', async () => {
      aiToolInvocation.updateMany.mockRejectedValueOnce(new Error('db blip'));
      const result = await tools.invoke(
        'thing_rename',
        { id: 't1', name: 'x' },
        { identity: service(SA.writer), channel: 'HEADLESS' },
      );
      expect(result.ok).toBe(true);
      expect(ledger.map((e) => e.event)).toEqual(['ATTEMPTED', 'EXECUTED']);
    });

    it('refuses a reject past expiry and marks the action EXPIRED', async () => {
      const action = await proposeOk('thing_rename');
      invocations.get(action.id)!.expiresAt = new Date(Date.now() - 1000);
      await expect(
        tools.reject(action.id, chat(human(ID.member))),
      ).rejects.toMatchObject({ status: 409 });
      expect(invocations.get(action.id)!.status).toBe('EXPIRED');
      expect(events(action.id)).toEqual(['PROPOSED', 'EXPIRED']);
    });

    describe('step-up derived by core (CEO decision 2026-09-24)', () => {
      it.each([
        'thing_set_role',
        'thing_set_email',
        'thing_grant',
        'thing_send_invite',
        'thing_enable_critical_workflow',
        'thing_revoke_critical',
      ])(
        '%s: a role/identity change, privilege grant, credential delivery or critical-application action requires step-up though the tool did not ask',
        async (name) => {
          const action = await proposeOk(name);
          expect(action.preview?.stepUpRequired).toBe(true);
          await expect(
            tools.approve(action.id, chat(human(ID.member))),
          ).rejects.toMatchObject({
            status: 403,
            response: { code: 'STEP_UP_REQUIRED' },
          });
          // Re-derived at approve even if the stored flag was lowered.
          const row = invocations.get(action.id)!;
          row.preview = {
            ...(row.preview as Record<string, unknown>),
            stepUpRequired: false,
          };
          await expect(
            tools.approve(action.id, chat(human(ID.member))),
          ).rejects.toMatchObject({ status: 403 });
          expect(updates).toBe(0);
        },
      );

      it.each(['thing_notify', 'thing_create_outbound'])(
        '%s: an elevated action with a warning outside the list (incl. OUTBOUND_INTEGRATION) needs no step-up',
        async (name) => {
          const action = await proposeOk(name);
          expect(action.preview?.stepUpRequired).toBe(false);
          const approved = await tools.approve(
            action.id,
            chat(human(ID.member)),
          );
          expect(approved.status).toBe('SUCCEEDED');
        },
      );

      it('refuses an elevated preview that carries no warning (unclassified)', async () => {
        const proposal = await tools.propose(
          'thing_unclassified',
          { id: 't1', name: 'x' },
          chat(human(ID.member)),
        );
        expect(proposal).toMatchObject({
          ok: false,
          result: { error: { code: 'INTERNAL' } },
        });
        expect(invocations.size).toBe(0);
      });
    });
  });

  // Every test above ends here: the app never updates or deletes a ledger row (INV-AI-10).
  afterEach(() => {
    for (const method of [
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ] as const) {
      expect(aiActionLog[method]).not.toHaveBeenCalled();
    }
  });
});
