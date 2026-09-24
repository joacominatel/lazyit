/**
 * Test harness for the AI HTTP surfaces (W3-1) — not a spec itself (`*.harness-spec.ts` is excluded from
 * the build and not matched by Jest). It mounts the REAL controllers, services, the SSE stream, the global
 * `RolesGuard` and the zod validation pipe in a Nest application over the REAL runtime of
 * `runtime.harness-spec.ts` (orchestrator, loop, approvals with the password step-up, the in-process event
 * bus) and its in-memory database. Only authentication is stood in: a guard sets the principal from the
 * `X-Test-Principal` header, as `JwtAuthGuard` does in the app.
 *
 * The importing spec must mock the generated Prisma client first (see `jest.mock` in each spec).
 */
import {
  ConflictException,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import type { Permission } from '@lazyit/shared';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import type { Principal } from '../../auth/principal';
import { RolesGuard } from '../../auth/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AiConversationsController } from '../conversations/ai-conversations.controller';
import { AiConversationsService } from '../conversations/ai-conversations.service';
import { AiModelCatalogService } from '../conversations/ai-model-catalog.service';
import { AiModelsController } from '../conversations/ai-models.controller';
import { AiModelListService } from '../providers/ai-model-list.service';
import { AI_SETTINGS_READER } from '../core/ports/ai-settings.port';
import { AiToolRegistry } from '../core/tool-registry';
import { AiServiceAccountAccessController } from '../headless/ai-service-account-access.controller';
import { AiServiceAccountAccessService } from '../headless/ai-service-account-access.service';
import { AiConversationPurgeService } from '../retention/ai-conversation-purge.service';
import { AgentRunOrchestrator } from '../runtime/agent-run.orchestrator';
import { AiApprovalService } from '../runtime/approval.service';
import { InProcessRunEventBus } from '../runtime/run-event-bus';
import {
  buildRuntime,
  OTHER_USER_ID,
  SA_ID,
  USER_ID,
  type Runtime,
} from '../runtime/runtime.harness-spec';
import { AiRunsController } from './ai-runs.controller';
import { AiRunsService } from './ai-runs.service';
import {
  AI_RUN_STREAM_OPTIONS,
  AiRunEventStream,
  type AiRunStreamOptions,
} from './run-event-stream';
import { AiStreamPrincipalCheck } from './stream-principal-check';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- a structural in-memory Prisma extended for the HTTP surfaces; intentional for this test harness only. */

type Row = Record<string, any>;

export const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
export const OTHER_SA_ID = 'csa0000000000000000000002';

/** The test principals, by `X-Test-Principal`. `A` is the runtime harness's user; `B` another member. */
export type TestPrincipal = 'A' | 'B' | 'ADMIN' | 'SA' | 'SA2' | 'SA_ADMIN';

const USERS: Record<string, Row> = {
  A: {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'MEMBER',
    sessionEpoch: 3,
    isActive: true,
  },
  B: {
    id: OTHER_USER_ID,
    firstName: 'Bob',
    lastName: 'Byte',
    role: 'MEMBER',
    sessionEpoch: 1,
    isActive: true,
  },
  ADMIN: {
    id: ADMIN_ID,
    firstName: 'Ann',
    lastName: 'Admin',
    role: 'ADMIN',
    sessionEpoch: 0,
    isActive: true,
  },
};

/**
 * The retention unit's purge service (W3-6), faked over the in-memory tables with its contract: owner
 * only (404), 409 `RUN_IN_PROGRESS` while a run is active, cascade of messages and invocations, runs
 * kept with a null conversation. Its own SQL is covered by `ai-retention.spec.ts`.
 */
function fakePurge(rt: Runtime) {
  const tables = rt.prisma.tables;
  return {
    calls: [] as Array<{ identity: Row; conversationId: string }>,
    deleteOwned(identity: Row, conversationId: string): Promise<void> {
      this.calls.push({ identity, conversationId });
      const conv = (tables.aiConversation.rows as Row[]).find(
        (r) =>
          r.id === conversationId &&
          (identity.kind === 'human'
            ? r.userId === identity.userId
            : r.serviceAccountId === identity.serviceAccountId),
      );
      if (!conv) {
        return Promise.reject(
          new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Conversation not found',
          }),
        );
      }
      const active = (tables.aiRun.rows as Row[]).some(
        (run) =>
          run.conversationId === conversationId &&
          ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status),
      );
      if (active) {
        return Promise.reject(
          new ConflictException({
            code: 'RUN_IN_PROGRESS',
            message:
              'A run is active in this conversation; cancel it before deleting',
          }),
        );
      }
      tables.aiConversation.rows = (tables.aiConversation.rows as Row[]).filter(
        (r) => r !== conv,
      );
      tables.aiMessage.rows = (tables.aiMessage.rows as Row[]).filter(
        (m) => m.conversationId !== conversationId,
      );
      tables.aiToolInvocation.rows = (
        tables.aiToolInvocation.rows as Row[]
      ).filter((i) => i.conversationId !== conversationId);
      for (const run of tables.aiRun.rows as Row[]) {
        if (run.conversationId === conversationId) run.conversationId = null;
      }
      return Promise.resolve();
    },
  };
}

export interface HttpHarness {
  purge: ReturnType<typeof fakePurge>;
  app: INestApplication;
  rt: Runtime;
  prisma: Row;
  stream: AiRunEventStream;
  /** Live, non-revoked Service Accounts (`serviceAccount.findUnique` sees only these). */
  serviceAccounts: Set<string>;
  auditRows: Row[];
  /** The provider model listing behind `GET /ai/models` (#1373): scripted, and counted. */
  models: {
    calls: number;
    next: () => Promise<Array<{ id: string; label: string | null }>>;
  };
  catalog: AiModelCatalogService;
  close(): Promise<void>;
}

/**
 * The runtime's in-memory Prisma, extended with what the HTTP services query beyond the runtime: the
 * conversation list (two-key order, skip), the Service Account lookup, the per-SA setting upsert and the
 * config audit log.
 */
function extendPrisma(
  rt: Runtime,
  serviceAccounts: Set<string>,
  auditRows: Row[],
): Row {
  const base = rt.prisma as Row;
  const tables = rt.prisma.tables;
  const convs = () => tables.aiConversation.rows as Row[];
  const matchesOwner = (row: Row, where: Row) =>
    (where.id === undefined || row.id === where.id) &&
    (where.userId === undefined || row.userId === where.userId) &&
    (where.channel === undefined || row.channel === where.channel);

  const aiConversation = {
    create: (args: Row) => base.aiConversation.create(args),
    findUnique: (args: Row) => base.aiConversation.findUnique(args),
    findFirst: (args: Row) => base.aiConversation.findFirst(args),
    updateMany: (args: Row) => base.aiConversation.updateMany(args),
    update: (args: Row) => base.aiConversation.update(args),
    count: ({ where }: Row) =>
      Promise.resolve(convs().filter((r) => matchesOwner(r, where)).length),
    findMany: ({ where, skip = 0, take }: Row) =>
      Promise.resolve(
        convs()
          .filter((r) => matchesOwner(r, where))
          .sort(
            (a, b) =>
              b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
              (a.id < b.id ? 1 : -1),
          )
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((r) => structuredClone(r)),
      ),
  };

  const settingsTable = tables.aiServiceAccountSettings;
  const aiServiceAccountSettings = {
    findUnique: (args: Row) => base.aiServiceAccountSettings.findUnique(args),
    upsert: ({ where, create, update }: Row) => {
      const row = (settingsTable.rows as Row[]).find(
        (r) => r.serviceAccountId === where.serviceAccountId,
      );
      if (row) Object.assign(row, update, { updatedAt: new Date() });
      else settingsTable.rows.push({ ...create, createdAt: new Date() });
      return Promise.resolve({});
    },
  };

  const extended: Row = Object.create(base);
  Object.assign(extended, {
    aiConversation,
    aiServiceAccountSettings,
    serviceAccount: {
      findUnique: ({ where }: Row) =>
        Promise.resolve(
          serviceAccounts.has(where.id) ? { id: where.id } : null,
        ),
    },
    aiConfigAuditLog: {
      create: ({ data }: Row) => {
        const row = {
          id: auditRows.length + 1,
          createdAt: new Date(),
          ...data,
        };
        auditRows.push(row);
        return Promise.resolve(row);
      },
    },
  });
  return extended;
}

/** Stand-in for JwtAuthGuard: the principal named by `X-Test-Principal`. */
function fakeAuthGuard(rt: Runtime) {
  @Injectable()
  class FakeAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        principal?: Principal;
        user?: unknown;
      }>();
      const who = req.headers['x-test-principal'];
      if (who && USERS[who]) {
        const user = { ...USERS[who] };
        if (who === 'A') user.sessionEpoch = rt.loader.user.sessionEpoch;
        req.user = user;
        req.principal = { kind: 'human', user } as Principal;
      } else if (who === 'SA' || who === 'SA2' || who === 'SA_ADMIN') {
        req.principal = {
          kind: 'service',
          serviceAccount: { id: who === 'SA2' ? OTHER_SA_ID : SA_ID },
          permissions:
            who === 'SA_ADMIN'
              ? new Set<Permission>(['settings:manage', 'ai:use'])
              : new Set(rt.loader.saPermissions),
        } as unknown as Principal;
      }
      return true;
    }
  }
  return FakeAuthGuard;
}

export async function buildHttp(
  options: AiRunStreamOptions = {},
): Promise<HttpHarness> {
  const rt = buildRuntime();
  const serviceAccounts = new Set([SA_ID, OTHER_SA_ID]);
  const auditRows: Row[] = [];
  const prisma = extendPrisma(rt, serviceAccounts, auditRows);
  const purge = fakePurge(rt);

  // The runtime's loader knows one user; teach it B too, so B's own requests pass the runtime and only
  // ownership decides what B sees of A's.
  const loadHuman = rt.loader.loadHuman.bind(rt.loader);
  (rt.loader as Row).loadHuman = (userId: string, epoch: number) =>
    userId === OTHER_USER_ID && epoch === USERS.B.sessionEpoch
      ? Promise.resolve({
          ok: true,
          principal: { kind: 'human', user: { ...USERS.B } },
        })
      : loadHuman(userId, epoch);

  // The role matrix: ADMIN holds everything, a MEMBER what the runtime harness grants members.
  const resolver = {
    resolve: (role: string) =>
      Promise.resolve(
        role === 'ADMIN'
          ? new Set<Permission>(['ai:use', 'ai:connect', 'settings:manage'])
          : new Set(rt.permissions.memberPermissions),
      ),
    hasAll: (role: string, required: readonly Permission[]) =>
      Promise.resolve(
        role === 'ADMIN' ||
          required.every((p) => rt.permissions.memberPermissions.has(p)),
      ),
  };

  const models: HttpHarness['models'] = {
    calls: 0,
    next: () =>
      Promise.resolve([
        { id: 'claude-opus-5', label: 'Claude Opus 5' },
        { id: 'claude-haiku-5', label: null },
      ]),
  };
  const lister = {
    listModels: () => {
      models.calls += 1;
      return models.next();
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [
      AiConversationsController,
      AiModelsController,
      AiRunsController,
      AiServiceAccountAccessController,
    ],
    providers: [
      Reflector,
      AiConversationsService,
      AiModelCatalogService,
      { provide: AiModelListService, useValue: lister },
      AiRunsService,
      AiRunEventStream,
      AiServiceAccountAccessService,
      AiStreamPrincipalCheck,
      { provide: AiConversationPurgeService, useValue: purge },
      { provide: PrincipalLoaderService, useValue: rt.loader },
      {
        provide: AI_RUN_STREAM_OPTIONS,
        useValue: { heartbeatMs: 60_000, ...options },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: AgentRunOrchestrator, useValue: rt.orchestrator },
      { provide: AiApprovalService, useValue: rt.approvals },
      { provide: InProcessRunEventBus, useValue: rt.bus },
      { provide: AiToolRegistry, useValue: rt.registry },
      { provide: AI_SETTINGS_READER, useValue: rt.settings },
      { provide: PermissionResolverService, useValue: resolver },
      { provide: APP_GUARD, useClass: fakeAuthGuard(rt) },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    app,
    rt,
    prisma,
    purge,
    stream: moduleRef.get(AiRunEventStream),
    serviceAccounts,
    auditRows,
    models,
    catalog: moduleRef.get(AiModelCatalogService),
    close: () => app.close(),
  };
}

/** Parse an SSE body into its frames (comments dropped). */
export function parseSse(
  body: string,
): Array<{ id?: string; event?: string; data: any }> {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').filter((line) => !line.startsWith(':')))
    .filter((lines) => lines.length > 0 && lines.some((l) => l.length > 0))
    .map((lines) => {
      const frame: { id?: string; event?: string; data: any } = { data: null };
      for (const line of lines) {
        const at = line.indexOf(': ');
        const field = line.slice(0, at);
        const value = line.slice(at + 2);
        if (field === 'id') frame.id = value;
        if (field === 'event') frame.event = value;
        if (field === 'data') frame.data = JSON.parse(value);
      }
      return frame;
    });
}

/** A supertest parser that keeps a text/event-stream body as a string. */
export function sseText(
  res: NodeJS.ReadableStream & { setEncoding(e: string): void },
  done: (err: Error | null, body: string) => void,
): void {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    body += chunk;
  });
  res.on('end', () => done(null, body));
}
