import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  AiActionPreviewSchema,
  AiToolResultSchema,
  DEFAULT_ROLE_PERMISSIONS,
  renderAssetTag,
  type AssetTagNextPreviewQuery,
  type Permission,
  type Role,
  type UpdateAssetTagScheme,
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
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { mintToken } from '../../service-accounts/service-account-token';
import { AssetTagSchemeController } from '../../asset-tag-scheme/asset-tag-scheme.controller';
import { AssetTagSchemeService } from '../../asset-tag-scheme/asset-tag-scheme.service';
import { AiActionLogService } from '../core/action-log.service';
import { AiToolService } from '../core/ai-tool.service';
import { AI_SETTINGS_READER } from '../core/ports/ai-settings.port';
import { AiToolDispatcher } from '../core/tool-dispatcher';
import { AiToolExecutor } from '../core/tool-executor';
import type { AiExecutionContext } from '../core/tool-descriptor';
import { AI_TOOLSETS, AiToolRegistry } from '../core/tool-registry';
import { assetTagSchemeToolset } from './asset-tag-scheme.tools';
import { assetsToolset } from './assets.tools';

/**
 * The ASSET TAG SCHEME tools (#1394) against the REAL `AssetTagSchemeController` (settings:manage,
 * ServicePrincipalForbiddenGuard), the real guard chain and validation pipe and the real AI core; the
 * scheme service is an in-memory fake with the route's semantics (unset default answered with
 * `updatedAt` = now, affixes replaced wholesale, the skip-existing next-tag preview).
 */

type Row = Record<string, unknown>;

// ─── Principals ──────────────────────────────────────────────────────────────────────────────────

const ID = {
  admin: 'aaaaaaaa-0000-4000-8000-000000000001',
  member: 'aaaaaaaa-0000-4000-8000-000000000002',
};
const SA_ID = 'cktagschemesettingssa0001';
const SA_GRANTS: Record<string, Permission[]> = {
  [SA_ID]: ['ai:use', 'settings:manage', 'asset:read'],
};
const SA_TOKENS = Object.fromEntries(
  Object.keys(SA_GRANTS).map((id) => [id, mintToken(id)]),
);

function user(id: string, role: Role) {
  return {
    id,
    email: `${role.toLowerCase()}@example.com`,
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
const USERS: Record<string, ReturnType<typeof user>> = {
  [ID.admin]: user(ID.admin, 'ADMIN'),
  [ID.member]: user(ID.member, 'MEMBER'),
};

interface Actor {
  label: string;
  identity: DelegatedIdentity;
}
const ADMIN: Actor = {
  label: 'ADMIN',
  identity: { kind: 'human', userId: ID.admin, sessionEpoch: 1 },
};
const MEMBER: Actor = {
  label: 'MEMBER',
  identity: { kind: 'human', userId: ID.member, sessionEpoch: 1 },
};
const SA: Actor = {
  label: 'SA with settings:manage',
  identity: { kind: 'service', serviceAccountId: SA_ID },
};

// ─── The scheme: an in-memory row with the service's semantics ───────────────────────────────────

const T0 = new Date('2026-09-01T00:00:00.000Z');
let scheme: Row | null;
let liveTags: string[];
let clock: number;

function resetStore(configured = true) {
  clock = 0;
  scheme = configured
    ? {
        id: 'singleton',
        prefix: 'LAP-',
        suffix: null,
        width: 5,
        nextNumber: 42,
        enabled: true,
        createdAt: T0,
        updatedAt: T0,
      }
    : null;
  liveTags = ['LAP-00042', 'LAP-00040'];
}

const wire = (r: Row) => ({
  prefix: r.prefix,
  suffix: r.suffix,
  width: r.width,
  nextNumber: r.nextNumber,
  enabled: r.enabled,
  createdAt: (r.createdAt as Date).toISOString(),
  updatedAt: (r.updatedAt as Date).toISOString(),
});

const schemeService = {
  getScheme: jest.fn(() => {
    if (!scheme) {
      // The route answers the unset default with a fresh timestamp on every read.
      const now = new Date(Date.now() + ++clock).toISOString();
      return Promise.resolve({
        prefix: null,
        suffix: null,
        width: null,
        nextNumber: 1,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    return Promise.resolve(wire(scheme));
  }),
  updateScheme: jest.fn((input: UpdateAssetTagScheme) => {
    const now = new Date(T0.getTime() + 60_000 * ++clock);
    scheme = {
      id: 'singleton',
      createdAt: scheme?.createdAt ?? now,
      nextNumber: input.startNumber ?? scheme?.nextNumber ?? 1,
      ...scheme,
      enabled: input.enabled,
      prefix: input.prefix ?? null,
      suffix: input.suffix ?? null,
      width: input.width ?? null,
      ...(input.startNumber !== undefined
        ? { nextNumber: input.startNumber }
        : {}),
      updatedAt: now,
    };
    return Promise.resolve(wire(scheme));
  }),
  previewNextTag: jest.fn((query: AssetTagNextPreviewQuery) => {
    const pattern = {
      prefix: query.prefix ?? null,
      suffix: query.suffix ?? null,
      width: query.width ?? null,
    };
    const from = query.from ?? (scheme?.nextNumber as number | undefined) ?? 1;
    let n = from;
    while (liveTags.includes(renderAssetTag(pattern, n))) n += 1;
    return Promise.resolve({
      fromNumber: from,
      number: n,
      tag: renderAssetTag(pattern, n),
      skippedCount: n - from,
      exhausted: false,
    });
  }),
  seedSuggestion: jest.fn(),
  backfillPreview: jest.fn(),
  backfillApply: jest.fn(),
  // The member-safe summary (#1315): the stored pattern and its skip-existing next tag, nothing else.
  getSummary: jest.fn(() => {
    const pattern = {
      prefix: (scheme?.prefix as string | null) ?? null,
      suffix: (scheme?.suffix as string | null) ?? null,
      width: (scheme?.width as number | null) ?? null,
    };
    const from = (scheme?.nextNumber as number | undefined) ?? 1;
    let n = from;
    while (liveTags.includes(renderAssetTag(pattern, n))) n += 1;
    return Promise.resolve({
      enabled: scheme?.enabled === true,
      ...pattern,
      nextTag: renderAssetTag(pattern, n),
      nextTagNumber: n,
      exhausted: false,
    });
  }),
};

// ─── An in-memory Prisma for the auth lookups and the AI tables ──────────────────────────────────

type InvocationRow = Row & { id: string };
let invocations: Map<string, InvocationRow>;
let ledger: Row[];
let nextInvocation: number;
let autoApprove: boolean;

function matches(r: InvocationRow, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = r[key];
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

const prisma = {
  user: {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(USERS[where.id] ?? null),
    ),
  },
  serviceAccount: {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        SA_GRANTS[where.id]
          ? {
              id: where.id,
              name: where.id,
              tokenHash: SA_TOKENS[where.id].tokenHash,
              tokenPrefix: SA_TOKENS[where.id].tokenPrefix,
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
        DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
          permission,
        })),
      ),
    ),
  },
  aiConversation: {
    findFirst: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        autoApprove && where.autoApprove === true && where.userId === ID.admin
          ? { autoApproveEnabledAt: T0 }
          : null,
      ),
    ),
  },
  aiToolInvocation: {
    create: jest.fn(({ data }: { data: Row }) => {
      nextInvocation += 1;
      const now = new Date();
      const r: InvocationRow = {
        id: `ckinvocation${String(nextInvocation).padStart(13, '0')}`,
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
      invocations.set(r.id, r);
      return Promise.resolve({ ...r });
    }),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of invocations.values()) {
        if (matches(r, where)) {
          Object.assign(r, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return Promise.resolve({ count });
    }),
    findUnique: jest.fn(({ where }: { where: { id: string } }) => {
      const r = invocations.get(where.id);
      return Promise.resolve(r ? { ...r } : null);
    }),
    findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => {
      const r = invocations.get(where.id);
      return r
        ? Promise.resolve({ ...r })
        : Promise.reject(new Error('not found'));
    }),
    findMany: jest.fn(({ where, take }: { where: Row; take?: number }) =>
      Promise.resolve(
        [...invocations.values()]
          .filter((r) => matches(r, where))
          .slice(0, take)
          .map((r) => ({ id: r.id })),
      ),
    ),
  },
  aiActionLog: {
    create: jest.fn(({ data }: { data: Row }) => {
      ledger.push(data);
      return Promise.resolve(data);
    }),
  },
  $transaction: jest.fn(
    async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = new Map(
        [...invocations].map(([id, r]) => [id, { ...r }]),
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

const events = (invocationId: string) =>
  ledger.filter((e) => e.invocationId === invocationId).map((e) => e.event);

describe('asset tag scheme toolset (#1394)', () => {
  const originalMode = process.env.AUTH_MODE;
  let app: INestApplication<App>;
  let tools: AiToolService;

  beforeAll(async () => {
    process.env.AUTH_MODE = 'local';
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetTagSchemeController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: LocalCredentialService,
          useValue: {
            verifySession: (token: string) =>
              token.startsWith('session:')
                ? Promise.resolve({
                    sub: token.slice('session:'.length),
                    epoch: 1,
                    rememberMe: false,
                  })
                : Promise.reject(new Error('bad token')),
          },
        },
        PermissionResolverService,
        PrincipalLoaderService,
        ServiceAccountAuthenticator,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: MustChangePasswordGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: AssetTagSchemeService, useValue: schemeService },
        {
          provide: AI_SETTINGS_READER,
          useValue: {
            getSettings: () => Promise.resolve({ approvalTtlMinutes: 30 }),
          },
        },
        AiToolDispatcher,
        AiToolRegistry,
        AiToolExecutor,
        AiActionLogService,
        AiToolService,
        { provide: AI_TOOLSETS, useValue: [assetTagSchemeToolset] },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    tools = app.get(AiToolService);
  });

  afterAll(async () => {
    await app.close();
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(() => {
    resetStore();
    invocations = new Map();
    ledger = [];
    nextInvocation = 0;
    autoApprove = false;
    jest.clearAllMocks();
  });

  const chat = (a: Actor): AiExecutionContext => ({
    identity: a.identity,
    channel: 'CHAT',
    conversationId: 'ckconversation000000000001',
    runId: 'ckrun0000000000000000000001',
  });
  const mcp = (
    a: Actor,
    ceiling: AiExecutionContext['ceiling'],
  ): AiExecutionContext => ({
    identity: a.identity,
    channel: 'MCP',
    mcp: { grantId: 'grant1', clientId: 'client1' },
    ceiling,
  });
  const headless = (a: Actor): AiExecutionContext => ({
    identity: a.identity,
    channel: 'HEADLESS',
    runId: 'ckheadlessrun00000000000001',
  });

  async function propose(input: unknown, a = ADMIN) {
    const proposal = await tools.propose(
      'asset_tag_scheme_update',
      input,
      chat(a),
      { toolUseId: 'toolu_1' },
    );
    if (!proposal.ok) throw new Error(JSON.stringify(proposal.result));
    expect(
      AiActionPreviewSchema.safeParse(proposal.action.preview).success,
    ).toBe(true);
    return proposal.action;
  }

  async function refused(input: unknown, a = ADMIN) {
    const proposal = await tools.propose(
      'asset_tag_scheme_update',
      input,
      chat(a),
    );
    expect(proposal.ok).toBe(false);
    return (
      proposal as { result: { error: { code: string; message: string } } }
    ).result.error;
  }

  // ─── Listing ───────────────────────────────────────────────────────────────────────────────────

  it('lists the read to whoever may create assets (ADMIN, MEMBER) and the update to an ADMIN only — never to a Service Account', async () => {
    const names = async (ctx: AiExecutionContext) =>
      (await tools.list(ctx)).map((t) => t.name);
    expect(await names(chat(ADMIN))).toEqual([
      'asset_tag_scheme_get',
      'asset_tag_scheme_update',
    ]);
    // #1315: read widened to asset:write, so a member follows the instance's tag scheme.
    expect(await names(chat(MEMBER))).toEqual(['asset_tag_scheme_get']);
    expect(await names(headless(SA))).toEqual([]);
    const update = (await tools.list(chat(ADMIN))).find(
      (t) => t.name === 'asset_tag_scheme_update',
    )!;
    expect(update.class).toBe('elevated');
    expect(update.description).toMatch(/ONLY/);
    expect(update.description).toMatch(/existing asset tags are never/);
  });

  it.each(['asset_create', 'asset_create_batch'])(
    '%s tells every caller to leave the tag to the scheme (whether or not it can read the scheme)',
    (name) => {
      const tool = assetsToolset.tools.find((t) => t.name === name)!;
      expect(tool.description).toMatch(
        /Omit (a row's )?assetTag unless the person gives one/,
      );
      expect(tool.description).toMatch(/the instance tag scheme assigns it/);
      expect(tool.description).toMatch(/never build one from a pattern/);
    },
  );

  // ─── asset_tag_scheme_get ──────────────────────────────────────────────────────────────────────

  describe('asset_tag_scheme_get', () => {
    it.each([
      ['ADMIN', ADMIN],
      ['MEMBER (asset:write, no settings:manage — #1315)', MEMBER],
    ])(
      '%s: the pattern, and the next tag the server would assign (taken numbers skipped) — no counter internals',
      async (_label, actor) => {
        const result = await tools.invoke(
          'asset_tag_scheme_get',
          {},
          chat(actor),
        );
        expect(AiToolResultSchema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
          ok: true,
          kind: 'read',
          mutated: false,
          data: {
            visible: true,
            enabled: true,
            prefix: '<untrusted_content>LAP-</untrusted_content>',
            suffix: null,
            width: 5,
            nextTag: {
              tag: '<untrusted_content>LAP-00043</untrusted_content>',
              number: 43,
            },
            exhausted: false,
          },
          summary: expect.stringContaining('LAP-00043') as unknown,
        });
        const data = (result as { data: Row & { guidance: string } }).data;
        expect(data.guidance).toMatch(/omit assetTag/);
        expect(data.guidance).toMatch(/Never compose a tag/);
        // The member-safe route only: the settings routes are not read, and nothing internal leaks.
        expect(schemeService.getSummary).toHaveBeenCalledTimes(1);
        expect(schemeService.getScheme).not.toHaveBeenCalled();
        expect(schemeService.previewNextTag).not.toHaveBeenCalled();
        expect(data).not.toHaveProperty('nextNumber');
        expect(data).not.toHaveProperty('updatedAt');
      },
    );

    it('never configured: the scheme is off', async () => {
      resetStore(false);
      const result = await tools.invoke(
        'asset_tag_scheme_get',
        {},
        chat(MEMBER),
      );
      expect(result).toMatchObject({
        ok: true,
        data: { visible: true, enabled: false },
        summary: 'The asset tag scheme is off: assets get no automatic tag.',
      });
      expect((result as { data: { guidance: string } }).data.guidance).toMatch(
        /gets no tag/,
      );
    });

    it('a Service Account: the route is human-only, and the tool says so with the guidance instead of an error', async () => {
      const result = await tools.invoke(
        'asset_tag_scheme_get',
        {},
        headless(SA),
      );
      expect(result).toMatchObject({
        ok: true,
        data: { visible: false },
        summary: 'The asset tag scheme is not visible to you.',
      });
      const data = (result as { data: Row }).data;
      expect(data.guidance).toMatch(/omit assetTag/);
      expect(data).not.toHaveProperty('prefix');
      expect(schemeService.getSummary).not.toHaveBeenCalled();
    });
  });

  // ─── asset_tag_scheme_update ───────────────────────────────────────────────────────────────────

  describe('asset_tag_scheme_update', () => {
    it('an elevated card with before → after of the changed fields, the next tag, the target and its version; runs once on approval', async () => {
      const action = await propose({ prefix: 'NB-', width: 4 });
      expect(action.preview).toMatchObject({
        toolName: 'asset_tag_scheme_update',
        class: 'elevated',
        elevated: true,
        stepUpRequired: false,
        warnings: ['INSTANCE_CONFIGURATION'],
        target: {
          type: 'assetTagScheme',
          id: 'singleton',
          op: 'updated',
          label: 'Asset tag scheme',
        },
        changes: [
          { field: 'prefix', before: 'LAP-', after: 'NB-', valueKind: 'text' },
          { field: 'width', before: 5, after: 4, valueKind: 'number' },
          { field: 'nextTag', before: 'LAP-00043', after: 'NB-0042' },
        ],
        precondition: {
          entity: { type: 'assetTagScheme', id: 'singleton' },
          updatedAt: T0.toISOString(),
        },
      });
      expect(schemeService.updateScheme).not.toHaveBeenCalled();

      const approved = await tools.approve(action.id, chat(ADMIN));
      expect(approved).toMatchObject({
        status: 'SUCCEEDED',
        result: {
          ok: true,
          kind: 'mutation',
          mutated: true,
          entityRefs: [{ type: 'assetTagScheme', id: 'singleton' }],
        },
      });
      // The route replaces affixes wholesale: the fields not mentioned are sent with their value.
      expect(schemeService.updateScheme).toHaveBeenCalledTimes(1);
      expect(schemeService.updateScheme).toHaveBeenCalledWith({
        enabled: true,
        prefix: 'NB-',
        width: 4,
      });
      expect(scheme).toMatchObject({ nextNumber: 42, prefix: 'NB-' });
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTED']);
    });

    it('turns it off, clears an affix with null, and re-seeds the counter', async () => {
      scheme = { ...scheme!, suffix: '-X' };
      const action = await propose({
        enabled: false,
        suffix: null,
        startNumber: 1000,
      });
      expect(action.preview!.changes).toEqual([
        {
          field: 'enabled',
          before: true,
          after: false,
          valueKind: 'boolean',
        },
        { field: 'suffix', before: '-X', after: null, valueKind: 'text' },
        {
          field: 'nextNumber',
          before: 42,
          after: 1000,
          valueKind: 'number',
        },
        {
          field: 'nextTag',
          before: 'LAP-00042-X',
          after: 'None (automatic tagging is off)',
          valueKind: 'text',
        },
      ]);
      await tools.approve(action.id, chat(ADMIN));
      expect(schemeService.updateScheme).toHaveBeenCalledWith({
        enabled: false,
        prefix: 'LAP-',
        width: 5,
        startNumber: 1000,
      });
    });

    it('a scheme changed since the card (another edit, or the counter moved) is STALE and nothing runs', async () => {
      const action = await propose({ prefix: 'NB-' });
      scheme = {
        ...scheme!,
        nextNumber: 44,
        updatedAt: new Date(T0.getTime() + 5_000),
      };
      const stale = await tools.approve(action.id, chat(ADMIN));
      expect(stale.status).toBe('FAILED');
      expect(stale.result).toMatchObject({
        ok: false,
        error: { code: 'STALE', status: 409 },
      });
      expect(schemeService.updateScheme).not.toHaveBeenCalled();
      expect(events(action.id)).toEqual(['PROPOSED', 'APPROVED', 'FAILED']);
    });

    it('a never-configured scheme is versioned on a fixed anchor, so its approval is not STALE', async () => {
      resetStore(false);
      const action = await propose({ enabled: true, prefix: 'IT-' });
      expect(action.preview).toMatchObject({
        changes: [
          { field: 'enabled', before: false, after: true },
          { field: 'prefix', before: null, after: 'IT-' },
          {
            field: 'nextTag',
            before: 'None (automatic tagging is off)',
            after: 'IT-1',
          },
        ],
        precondition: { updatedAt: new Date(0).toISOString() },
      });
      const approved = await tools.approve(action.id, chat(ADMIN));
      expect(approved.status).toBe('SUCCEEDED');
      expect(schemeService.updateScheme).toHaveBeenCalledWith({
        enabled: true,
        prefix: 'IT-',
      });
    });

    it.each([
      ['no field', {}],
      ['the current prefix', { prefix: 'LAP-' }],
      ['the same state and counter', { enabled: true, startNumber: 42 }],
      ['the current width', { width: 5 }],
    ])('a no-op (%s) is refused before any card', async (_label, input) => {
      const error = await refused(input);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(/Nothing to change/);
      expect(invocations.size).toBe(0);
    });

    it('validates with the route schema: bounds are refused before any card', async () => {
      for (const input of [
        { prefix: 'x'.repeat(65) },
        { width: 33 },
        { startNumber: -1 },
        { enabled: 'yes' },
        { prefix: '' },
        { unknown: 1 },
      ]) {
        const error = await refused(input);
        expect(error.code).toBe('INVALID_INPUT');
      }
      expect(invocations.size).toBe(0);
    });

    it('a stored value the route schema no longer accepts is reported, not silently written', async () => {
      scheme = { ...scheme!, suffix: 'y'.repeat(80) };
      const error = await refused({ prefix: 'NB-' });
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(/not valid: suffix/);
    });

    it('is never auto-approved, even with auto-approve on in the conversation', async () => {
      autoApprove = true;
      const action = await propose({ prefix: 'NB-' });
      await expect(
        tools.approve(action.id, chat(ADMIN), { auto: true }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'AUTO_APPROVE_NOT_ELIGIBLE' },
      });
      expect(schemeService.updateScheme).not.toHaveBeenCalled();
      expect(invocations.get(action.id)!.status).toBe('AWAITING_APPROVAL');
    });

    it('a MEMBER cannot propose it: no card for a change the route refuses', async () => {
      const error = await refused({ prefix: 'NB-' }, MEMBER);
      expect(error.code).toBe('FORBIDDEN');
      expect(schemeService.getScheme).not.toHaveBeenCalled();
    });

    it('MCP: needs the elevated scope (lazyit.admin); with it, the change runs as the admin', async () => {
      const blocked = await tools.invoke(
        'asset_tag_scheme_update',
        { prefix: 'NB-' },
        mcp(ADMIN, ['read', 'write']),
      );
      expect(blocked).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
      expect(schemeService.updateScheme).not.toHaveBeenCalled();

      const done = await tools.invoke(
        'asset_tag_scheme_update',
        { prefix: 'NB-' },
        mcp(ADMIN, ['read', 'write', 'elevated']),
      );
      expect(done).toMatchObject({ ok: true, mutated: true });
      expect(schemeService.updateScheme).toHaveBeenCalledWith({
        enabled: true,
        prefix: 'NB-',
        width: 5,
      });
    });

    it('headless: a Service Account is refused by the route even holding settings:manage', async () => {
      const result = await tools.invoke(
        'asset_tag_scheme_update',
        { prefix: 'NB-' },
        headless(SA),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(schemeService.updateScheme).not.toHaveBeenCalled();
    });
  });
});
