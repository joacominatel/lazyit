/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/no-this-alias -- the in-memory fake database reads loosely-typed Prisma args; intentional for this spec file only. */
// The generated client cannot load under Jest; nothing here needs it (the agent-run sweeper spec pattern).
jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: {} };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { AI_SETTINGS_DEFAULTS, type AiSettings } from '@lazyit/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AiSettingsReader } from '../core/ports/ai-settings.port';
import {
  AI_RETENTION_BATCH,
  AI_RETENTION_MAX_BATCHES_PER_PASS,
  AiConversationPurgeService,
  clampRetentionDays,
  retentionCutoff,
} from './ai-conversation-purge.service';
import { AiRetentionSweeper } from './ai-retention.sweeper';

/**
 * W3-6 — the retention sweeper and the purge service (ADR-0097 decision 11; provider-and-runtime.md §7).
 * The database is an in-memory fake that honours the real FK semantics (messages and invocations cascade
 * with their conversation, `AiRun.conversationId` is SetNull) and the row-lock hooks the purge relies on.
 * Touching `aiActionLog` or `aiUsage` at all throws.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-24T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface Conv {
  id: string;
  userId: string | null;
  serviceAccountId: string | null;
  lastActivityAt: Date;
}
interface Run {
  id: string;
  conversationId: string | null;
  status: string;
}
interface Msg {
  conversationId: string;
  runId: string | null;
}
interface Inv {
  id: string;
  conversationId: string | null;
  createdAt: Date;
  status: string;
}
interface UserRow {
  id: string;
  deletedAt: Date | null;
}

type Where = Record<string, any>;

function matchId(id: string, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === 'string') return id === cond;
  const c = cond as { gt?: string; in?: string[] };
  if (c.gt !== undefined && !(id > c.gt)) return false;
  if (c.in !== undefined && !c.in.includes(id)) return false;
  return true;
}

class FakeDb {
  conversations: Conv[] = [];
  runs: Run[] = [];
  messages: Msg[] = [];
  invocations: Inv[] = [];
  users: UserRow[] = [];
  actionLog = [{ id: 1, conversationId: 'c-old', runId: 'r-old' }];
  usage = [{ id: 1n, runId: 'r-old' }];

  /** Rows another transaction holds (SKIP LOCKED skips them). */
  held = new Set<string>();
  /** Runs while a blocking lock waits — simulates a concurrent writer that commits first. */
  onLockWait: (() => void) | null = null;
  queries: string[] = [];
  takes: number[] = [];
  failInvocations = false;

  private convMatches(c: Conv, w: Where = {}): boolean {
    for (const [key, value] of Object.entries(w)) {
      switch (key) {
        case 'AND':
          if (!(value as Where[]).every((sub) => this.convMatches(c, sub)))
            return false;
          break;
        case 'id':
          if (!matchId(c.id, value)) return false;
          break;
        case 'userId':
          if (c.userId !== value) return false;
          break;
        case 'serviceAccountId':
          if (c.serviceAccountId !== value) return false;
          break;
        case 'lastActivityAt':
          if (!(c.lastActivityAt < (value as { lt: Date }).lt)) return false;
          break;
        case 'user': {
          const owner = this.users.find((u) => u.id === c.userId);
          if (!owner || owner.deletedAt === null) return false;
          break;
        }
        case 'invocations': {
          const statuses = (value as { none: { status: { in: string[] } } })
            .none.status.in;
          if (
            this.invocations.some(
              (i) => i.conversationId === c.id && statuses.includes(i.status),
            )
          )
            return false;
          break;
        }
        case 'runs': {
          const statuses = (value as { none: { status: { in: string[] } } })
            .none.status.in;
          if (
            this.runs.some(
              (r) => r.conversationId === c.id && statuses.includes(r.status),
            )
          )
            return false;
          break;
        }
        default:
          throw new Error(`fake: unsupported conversation filter ${key}`);
      }
    }
    return true;
  }

  private invMatches(i: Inv, w: Where): boolean {
    if ('conversationId' in w) {
      const cond = w.conversationId;
      if (cond !== null && typeof cond === 'object') {
        if (i.conversationId === null || !cond.in.includes(i.conversationId))
          return false;
      } else if (i.conversationId !== cond) return false;
    }
    if (w.status?.in && !w.status.in.includes(i.status)) return false;
    if (w.createdAt && !(i.createdAt < w.createdAt.lt)) return false;
    if (w.status?.notIn && w.status.notIn.includes(i.status)) return false;
    return matchId(i.id, w.id);
  }

  private deleteConversations(ids: string[]): number {
    const doomed = new Set(ids);
    this.conversations = this.conversations.filter((c) => !doomed.has(c.id));
    this.messages = this.messages.filter((m) => !doomed.has(m.conversationId)); // Cascade
    this.invocations = this.invocations.filter(
      (i) => i.conversationId === null || !doomed.has(i.conversationId),
    ); // Cascade
    for (const run of this.runs) {
      if (run.conversationId && doomed.has(run.conversationId))
        run.conversationId = null; // SetNull
    }
    return doomed.size;
  }

  client(): PrismaService {
    const db = this;
    const sortById = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const client: Record<string, unknown> = {
      aiConversation: {
        findMany: jest.fn(async (args: { where: Where; take: number }) => {
          db.takes.push(args.take);
          return sortById(
            db.conversations.filter((c) => db.convMatches(c, args.where)),
          )
            .slice(0, args.take)
            .map((c) => ({ id: c.id }));
        }),
        findFirst: jest.fn(async (args: { where: Where }) => {
          const c = db.conversations.find((row) =>
            db.convMatches(row, args.where),
          );
          return c ? { id: c.id } : null;
        }),
        deleteMany: jest.fn(async (args: { where: Where }) => {
          const ids = db.conversations
            .filter((c) => db.convMatches(c, args.where))
            .map((c) => c.id);
          return { count: db.deleteConversations(ids) };
        }),
      },
      aiRun: {
        findMany: jest.fn(async (args: { where: Where }) =>
          db.runs
            .filter(
              (r) =>
                r.conversationId !== null &&
                args.where.conversationId.in.includes(r.conversationId) &&
                args.where.status.in.includes(r.status),
            )
            .map((r) => ({ conversationId: r.conversationId })),
        ),
      },
      aiToolInvocation: {
        findMany: jest.fn(async (args: { where: Where; take: number }) => {
          // The MCP step's scan (conversation-less rows) is the one that fails.
          if (db.failInvocations && args.where.conversationId === null)
            throw Object.assign(new Error('row value leaked: secret-title'), {
              code: 'P2010',
            });
          return sortById(
            db.invocations.filter((i) => db.invMatches(i, args.where)),
          )
            .slice(0, args.take)
            .map((i) => ({ id: i.id, conversationId: i.conversationId }));
        }),
        deleteMany: jest.fn(async (args: { where: Where }) => {
          const before = db.invocations.length;
          db.invocations = db.invocations.filter(
            (i) => !db.invMatches(i, args.where),
          );
          return { count: before - db.invocations.length };
        }),
      },
      $queryRaw: jest.fn(
        async (strings: TemplateStringsArray, ids: string[]) => {
          const sql = strings.join('?');
          db.queries.push(sql);
          const skipLocked = sql.includes('SKIP LOCKED');
          if (!skipLocked && db.onLockWait) {
            db.onLockWait();
            db.onLockWait = null;
          }
          return db.conversations
            .filter((c) => ids.includes(c.id))
            .filter((c) => !(skipLocked && db.held.has(c.id)))
            .map((c) => ({ id: c.id }));
        },
      ),
    };
    client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn(proxy),
    );
    const proxy: PrismaService = new Proxy(client, {
      get(target, prop) {
        if (prop === 'aiActionLog' || prop === 'aiUsage') {
          throw new Error(`retention must never touch ${String(prop)}`);
        }
        return target[prop as string];
      },
    }) as unknown as PrismaService;
    return proxy;
  }
}

function settingsReader(
  patch: Partial<AiSettings> = {},
): AiSettingsReader & { getSettings: jest.Mock } {
  return {
    getSettings: jest.fn(async () => ({
      ...(AI_SETTINGS_DEFAULTS as unknown as AiSettings),
      ...patch,
    })),
    resolveProviderConfig: jest.fn(async () => null),
  };
}

function setup(patch: Partial<AiSettings> = {}) {
  const db = new FakeDb();
  const settings = settingsReader(patch);
  const prisma = db.client();
  const purge = new AiConversationPurgeService(prisma, settings);
  const sweeper = new AiRetentionSweeper(purge);
  return { db, settings, prisma, purge, sweeper };
}

function conv(
  db: FakeDb,
  id: string,
  lastActivityAt: Date,
  owner: { userId?: string; serviceAccountId?: string } = { userId: 'u1' },
) {
  db.conversations.push({
    id,
    userId: owner.userId ?? null,
    serviceAccountId: owner.serviceAccountId ?? null,
    lastActivityAt,
  });
  db.messages.push({ conversationId: id, runId: null });
  db.invocations.push({
    id: `inv-${id}`,
    conversationId: id,
    createdAt: lastActivityAt,
    status: 'SUCCEEDED',
  });
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('retention setting bounds', () => {
  it.each([
    [90, 90],
    [7, 7],
    [3650, 3650],
    [6, 7],
    [0, 7],
    [-5, 7],
    [3651, 3650],
    [999_999, 3650],
    [1.5, 90],
    [Number.NaN, 90],
    [null, 90],
    ['30', 90],
  ])('clamps %p to %p', (value, expected) => {
    expect(clampRetentionDays(value)).toBe(expected);
  });

  it('reads the window through AI_SETTINGS_READER and clamps a hand-edited row', async () => {
    const { db, sweeper, settings } = setup({ retentionDays: 1 });
    conv(db, 'c-3d', ago(3 * DAY));
    conv(db, 'c-8d', ago(8 * DAY));
    const result = await sweeper.sweep(NOW);
    expect(settings.getSettings).toHaveBeenCalled();
    expect(result.retentionDays).toBe(7); // never the 1 day the row says
    expect(db.conversations.map((c) => c.id)).toEqual(['c-3d']);
  });

  it('uses a configured window', async () => {
    const { db, sweeper } = setup({ retentionDays: 30 });
    conv(db, 'c-29d', ago(29 * DAY));
    conv(db, 'c-31d', ago(31 * DAY));
    await sweeper.sweep(NOW);
    expect(db.conversations.map((c) => c.id)).toEqual(['c-29d']);
  });

  it('skips the whole pass when the settings cannot be read (never guesses a window)', async () => {
    const { db, sweeper, settings } = setup();
    settings.getSettings.mockRejectedValue(new Error('db down'));
    conv(db, 'c-old', ago(400 * DAY));
    db.invocations.push({
      id: 'mcp-old',
      conversationId: null,
      createdAt: ago(400 * DAY),
      status: 'SUCCEEDED',
    });
    const result = await sweeper.sweep(NOW);
    expect(result).toEqual({
      retentionDays: null,
      expired: 0,
      offboarded: 0,
      mcpInvocations: 0,
    });
    expect(db.conversations).toHaveLength(1);
    expect(db.invocations).toHaveLength(2);
  });

  it('keeps sweeping while the assistant is disabled (conversations stay dormant, retention runs)', async () => {
    const { db, sweeper } = setup({ enabled: false });
    conv(db, 'c-old', ago(91 * DAY));
    const result = await sweeper.sweep(NOW);
    expect(result.expired).toBe(1);
  });
});

describe('age boundary', () => {
  it('deletes strictly older than now − retentionDays by last activity, and nothing newer', async () => {
    const { db, sweeper } = setup(); // 90 days
    const cutoff = retentionCutoff(90, NOW);
    conv(db, 'c-at-cutoff', cutoff);
    conv(db, 'c-just-past', new Date(cutoff.getTime() - 1));
    conv(db, 'c-just-inside', new Date(cutoff.getTime() + 1));
    conv(db, 'c-fresh', ago(DAY));
    const result = await sweeper.sweep(NOW);
    expect(result.expired).toBe(1);
    expect(db.conversations.map((c) => c.id).sort()).toEqual([
      'c-at-cutoff',
      'c-fresh',
      'c-just-inside',
    ]);
  });
});

describe('kept tables', () => {
  it('cascades messages and invocations, keeps AiRun (SetNull), never touches AiActionLog or AiUsage', async () => {
    const { db, sweeper, prisma } = setup();
    conv(db, 'c-old', ago(100 * DAY));
    conv(db, 'c-new', ago(DAY));
    db.runs.push({ id: 'r-old', conversationId: 'c-old', status: 'SUCCEEDED' });
    db.messages.push({ conversationId: 'c-old', runId: 'r-old' });
    const ledger = structuredClone(db.actionLog);
    const usage = [...db.usage];

    await sweeper.sweep(NOW);

    expect(db.messages.map((m) => m.conversationId)).toEqual(['c-new']);
    expect(db.invocations.map((i) => i.conversationId)).toEqual(['c-new']);
    expect(db.runs).toEqual([
      { id: 'r-old', conversationId: null, status: 'SUCCEEDED' },
    ]);
    expect(db.actionLog).toEqual(ledger);
    expect(db.usage).toEqual(usage);
    // The fake throws on any access to aiActionLog / aiUsage; the run delegate is only ever read.
    const aiRun = (prisma as unknown as { aiRun: Record<string, unknown> })
      .aiRun;
    expect(Object.keys(aiRun)).toEqual(['findMany']);
  });

  it('the retention sources never name the ledgers or write AiRun', () => {
    const dir = __dirname;
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const source of sources) {
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code).not.toMatch(/aiActionLog|ai_action_log|aiUsage|ai_usage/);
      expect(code).not.toMatch(
        /aiRun\.(delete|deleteMany|update|updateMany|create|upsert)\b/,
      );
      expect(code).not.toMatch(/\$executeRaw/);
    }
  });
});

describe('active runs', () => {
  it.each(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'])(
    'skips a conversation with a %s run and purges it on the next pass once the run ends',
    async (status) => {
      const { db, sweeper } = setup();
      conv(db, 'c-busy', ago(100 * DAY));
      db.runs.push({ id: 'r1', conversationId: 'c-busy', status });
      expect((await sweeper.sweep(NOW)).expired).toBe(0);
      expect(db.conversations).toHaveLength(1);

      db.runs[0].status = 'SUCCEEDED';
      expect((await sweeper.sweep(NOW)).expired).toBe(1);
      expect(db.conversations).toHaveLength(0);
    },
  );

  it.each(['AWAITING_APPROVAL', 'EXECUTING'])(
    'skips a conversation holding a %s tool invocation and purges it once the invocation settles',
    async (status) => {
      const { db, sweeper } = setup();
      conv(db, 'c-inflight', ago(100 * DAY));
      db.invocations.push({
        id: 'inv-pending',
        conversationId: 'c-inflight',
        createdAt: ago(100 * DAY),
        status,
      });
      expect((await sweeper.sweep(NOW)).expired).toBe(0);
      expect(db.invocations.map((i) => i.id)).toContain('inv-pending');

      db.invocations.find((i) => i.id === 'inv-pending')!.status = 'SUCCEEDED';
      expect((await sweeper.sweep(NOW)).expired).toBe(1);
      expect(db.conversations).toHaveLength(0);
    },
  );

  it('re-checks invocations after the lock: one that went EXECUTING between the scan and the lock keeps the conversation', async () => {
    const { db, purge, prisma } = setup();
    conv(db, 'c-race', ago(100 * DAY));
    const findMany = (
      prisma as unknown as { aiConversation: { findMany: jest.Mock } }
    ).aiConversation.findMany;
    const original = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args: unknown) => {
      const rows = await original(args);
      db.invocations.push({
        id: 'inv-exec',
        conversationId: 'c-race',
        createdAt: NOW,
        status: 'EXECUTING',
      });
      return rows;
    });
    const outcome = await purge.purgeWhere({
      lastActivityAt: { lt: retentionCutoff(90, NOW) },
    });
    expect(outcome).toEqual({ deleted: 0, skipped: 1 });
    expect(db.conversations).toHaveLength(1);
  });

  it('refuses an owner delete while a tool invocation is in flight', async () => {
    const { db, purge } = setup();
    conv(db, 'c1', ago(DAY), { userId: 'u1' });
    db.invocations.push({
      id: 'inv-wait',
      conversationId: 'c1',
      createdAt: NOW,
      status: 'AWAITING_APPROVAL',
    });
    await expect(
      purge.deleteOwned({ kind: 'human', userId: 'u1', sessionEpoch: 0 }, 'c1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.conversations).toHaveLength(1);
  });

  it('re-checks after the lock: a run committed between the scan and the lock keeps the conversation', async () => {
    const { db, purge, prisma } = setup();
    conv(db, 'c-race', ago(100 * DAY));
    const findMany = (
      prisma as unknown as { aiConversation: { findMany: jest.Mock } }
    ).aiConversation.findMany;
    const original = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args: unknown) => {
      const rows = await original(args);
      // A submission commits its run right after the candidate scan.
      db.runs.push({ id: 'r-new', conversationId: 'c-race', status: 'QUEUED' });
      return rows;
    });
    const outcome = await purge.purgeWhere({
      lastActivityAt: { lt: retentionCutoff(90, NOW) },
    });
    expect(outcome).toEqual({ deleted: 0, skipped: 1 });
    expect(db.conversations).toHaveLength(1);
  });

  it('skips a row another transaction holds (SKIP LOCKED) and leaves it for the next pass', async () => {
    const { db, sweeper } = setup();
    conv(db, 'c-held', ago(100 * DAY));
    conv(db, 'c-free', ago(100 * DAY));
    db.held.add('c-held');
    expect((await sweeper.sweep(NOW)).expired).toBe(1);
    expect(db.queries.every((q) => q.includes('FOR UPDATE SKIP LOCKED'))).toBe(
      true,
    );
    db.held.clear();
    expect((await sweeper.sweep(NOW)).expired).toBe(1);
    expect(db.conversations).toHaveLength(0);
  });

  it('re-applies the age guard at delete time (a submission that bumped lastActivityAt wins)', async () => {
    const { db, purge, prisma } = setup();
    conv(db, 'c-bumped', ago(100 * DAY));
    const findMany = (
      prisma as unknown as { aiConversation: { findMany: jest.Mock } }
    ).aiConversation.findMany;
    const original = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args: unknown) => {
      const rows = await original(args);
      db.conversations[0].lastActivityAt = NOW;
      return rows;
    });
    const outcome = await purge.purgeWhere({
      lastActivityAt: { lt: retentionCutoff(90, NOW) },
    });
    expect(outcome.deleted).toBe(0);
    expect(db.conversations).toHaveLength(1);
  });
});

describe('batches and idempotency', () => {
  it('deletes in batches of AI_RETENTION_BATCH and a second pass is a no-op', async () => {
    const { db, sweeper } = setup();
    for (let i = 0; i < 250; i++) {
      conv(db, `c-${String(i).padStart(4, '0')}`, ago(100 * DAY));
    }
    conv(db, 'z-fresh', ago(DAY));
    const first = await sweeper.sweep(NOW);
    expect(first.expired).toBe(250);
    expect(Math.max(...db.takes)).toBeLessThanOrEqual(AI_RETENTION_BATCH);
    expect(db.conversations.map((c) => c.id)).toEqual(['z-fresh']);

    const second = await sweeper.sweep(NOW);
    expect(second).toEqual({
      retentionDays: 90,
      expired: 0,
      offboarded: 0,
      mcpInvocations: 0,
    });
  });

  it('bounds one pass; the rest waits for the next', async () => {
    const { db, sweeper } = setup();
    const cap = AI_RETENTION_BATCH * AI_RETENTION_MAX_BATCHES_PER_PASS;
    for (let i = 0; i < cap + 5; i++) {
      conv(db, `c-${String(i).padStart(5, '0')}`, ago(100 * DAY));
    }
    expect((await sweeper.sweep(NOW)).expired).toBe(cap);
    expect((await sweeper.sweep(NOW)).expired).toBe(5);
  });

  it('does not loop on rows it cannot delete (the scan moves past them)', async () => {
    const { db, sweeper } = setup();
    for (let i = 0; i < AI_RETENTION_BATCH + 1; i++) {
      conv(db, `c-${String(i).padStart(4, '0')}`, ago(100 * DAY));
      db.held.add(`c-${String(i).padStart(4, '0')}`);
    }
    expect((await sweeper.sweep(NOW)).expired).toBe(0);
    expect(
      db.takes.filter((t) => t === AI_RETENTION_BATCH).length,
    ).toBeLessThan(10);
  });

  it('is re-entrancy guarded', async () => {
    const { db, sweeper, settings } = setup();
    conv(db, 'c-old', ago(100 * DAY));
    let release!: () => void;
    settings.getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(AI_SETTINGS_DEFAULTS);
        }),
    );
    const first = sweeper.sweep(NOW);
    const second = await sweeper.sweep(NOW);
    expect(second.retentionDays).toBeNull();
    release();
    expect((await first).expired).toBe(1);
  });

  it('isolates a failing step and logs its class and code, never its message', async () => {
    const { db, sweeper } = setup();
    conv(db, 'c-old', ago(100 * DAY));
    db.failInvocations = true;
    const result = await sweeper.sweep(NOW);
    expect(result.expired).toBe(1);
    expect(result.mcpInvocations).toBe(0);
    const logged = (Logger.prototype.error as jest.Mock).mock.calls
      .flat()
      .join(' ');
    expect(logged).toContain('P2010');
    expect(logged).not.toContain('secret-title');
  });

  it('logs counts only', async () => {
    const { db, sweeper } = setup();
    conv(db, 'c-old', ago(100 * DAY));
    await sweeper.sweep(NOW);
    const lines = (Logger.prototype.log as jest.Mock).mock.calls.flat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('c-old');
    expect(lines[0]).not.toContain('u1');
  });
});

describe('MCP invocations (conversation-less)', () => {
  it('prunes old, settled rows only', async () => {
    const { db, sweeper } = setup();
    const old = ago(100 * DAY);
    db.invocations.push(
      {
        id: 'm-old-ok',
        conversationId: null,
        createdAt: old,
        status: 'SUCCEEDED',
      },
      {
        id: 'm-old-denied',
        conversationId: null,
        createdAt: old,
        status: 'DENIED',
      },
      {
        id: 'm-old-exec',
        conversationId: null,
        createdAt: old,
        status: 'EXECUTING',
      },
      {
        id: 'm-old-wait',
        conversationId: null,
        createdAt: old,
        status: 'AWAITING_APPROVAL',
      },
      {
        id: 'm-new',
        conversationId: null,
        createdAt: ago(DAY),
        status: 'SUCCEEDED',
      },
    );
    conv(db, 'c-live', ago(DAY)); // its invocation is conversation-bound and fresh
    db.invocations.push({
      id: 'bound-old',
      conversationId: 'c-live',
      createdAt: old,
      status: 'SUCCEEDED',
    });
    const result = await sweeper.sweep(NOW);
    expect(result.mcpInvocations).toBe(2);
    expect(db.invocations.map((i) => i.id).sort()).toEqual([
      'bound-old',
      'inv-c-live',
      'm-new',
      'm-old-exec',
      'm-old-wait',
    ]);
  });
});

describe('offboarding purge', () => {
  it('the sweeper purges every conversation of an offboarded user, whatever its age', async () => {
    const { db, sweeper } = setup();
    db.users.push(
      { id: 'u-gone', deletedAt: ago(DAY) },
      { id: 'u-live', deletedAt: null },
    );
    conv(db, 'c-gone-fresh', ago(60_000), { userId: 'u-gone' });
    conv(db, 'c-gone-busy', ago(60_000), { userId: 'u-gone' });
    db.runs.push({ id: 'r', conversationId: 'c-gone-busy', status: 'RUNNING' });
    conv(db, 'c-live', ago(60_000), { userId: 'u-live' });
    conv(db, 'c-sa', ago(60_000), { serviceAccountId: 'sa-1' });

    const result = await sweeper.sweep(NOW);
    expect(result.offboarded).toBe(1);
    expect(db.conversations.map((c) => c.id).sort()).toEqual([
      'c-gone-busy',
      'c-live',
      'c-sa',
    ]);

    db.runs[0].status = 'FAILED'; // the offboarded user's run ends (session epoch bumped)
    expect((await sweeper.sweep(NOW)).offboarded).toBe(1);
    expect(db.conversations.map((c) => c.id).sort()).toEqual([
      'c-live',
      'c-sa',
    ]);
  });

  it('purgeForUser deletes only that user’s conversations, skipping active ones', async () => {
    const { db, purge } = setup();
    conv(db, 'c-a1', ago(DAY), { userId: 'a' });
    conv(db, 'c-a2', ago(DAY), { userId: 'a' });
    conv(db, 'c-a-busy', ago(DAY), { userId: 'a' });
    db.runs.push({
      id: 'r',
      conversationId: 'c-a-busy',
      status: 'AWAITING_APPROVAL',
    });
    conv(db, 'c-b', ago(DAY), { userId: 'b' });
    const outcome = await purge.purgeForUser('a');
    expect(outcome.deleted).toBe(2);
    expect(db.conversations.map((c) => c.id).sort()).toEqual([
      'c-a-busy',
      'c-b',
    ]);
    expect(await purge.purgeForUser('a')).toEqual({ deleted: 0, skipped: 0 });
  });
});

describe('owner-requested delete', () => {
  const human = (userId: string) =>
    ({ kind: 'human', userId, sessionEpoch: 0 }) as const;

  it('deletes the owner’s conversation (hard), keeping the run row', async () => {
    const { db, purge } = setup();
    conv(db, 'c1', ago(DAY), { userId: 'u1' });
    db.runs.push({ id: 'r1', conversationId: 'c1', status: 'SUCCEEDED' });
    await purge.deleteOwned(human('u1'), 'c1');
    expect(db.conversations).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    expect(db.invocations).toHaveLength(0);
    expect(db.runs[0].conversationId).toBeNull();
    // A blocking lock, not SKIP LOCKED: the owner's delete waits for a concurrent writer.
    expect(db.queries[0]).toContain('FOR UPDATE');
    expect(db.queries[0]).not.toContain('SKIP LOCKED');
  });

  it('is 404 for anyone else, and leaves the conversation', async () => {
    const { db, purge } = setup();
    conv(db, 'c1', ago(DAY), { userId: 'u1' });
    conv(db, 'c-sa', ago(DAY), { serviceAccountId: 'sa-1' });
    await expect(purge.deleteOwned(human('u2'), 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(purge.deleteOwned(human('u1'), 'c-sa')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      purge.deleteOwned({ kind: 'service', serviceAccountId: 'sa-2' }, 'c-sa'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(purge.deleteOwned(human('u1'), 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.conversations).toHaveLength(2);
    expect(db.queries).toHaveLength(0); // nothing was even locked
  });

  it('lets a service account delete its own headless conversation', async () => {
    const { db, purge } = setup();
    conv(db, 'c-sa', ago(DAY), { serviceAccountId: 'sa-1' });
    await purge.deleteOwned(
      { kind: 'service', serviceAccountId: 'sa-1' },
      'c-sa',
    );
    expect(db.conversations).toHaveLength(0);
  });

  it('is 409 RUN_IN_PROGRESS while a run is active, including one committed while the lock waited', async () => {
    const { db, purge } = setup();
    conv(db, 'c1', ago(DAY), { userId: 'u1' });
    db.runs.push({ id: 'r1', conversationId: 'c1', status: 'RUNNING' });
    const err = await purge.deleteOwned(human('u1'), 'c1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'RUN_IN_PROGRESS' });

    db.runs = [];
    db.onLockWait = () =>
      db.runs.push({ id: 'r2', conversationId: 'c1', status: 'QUEUED' });
    await expect(purge.deleteOwned(human('u1'), 'c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(db.conversations).toHaveLength(1);
  });

  it('is 404 when a concurrent delete won the race', async () => {
    const { db, purge } = setup();
    conv(db, 'c1', ago(DAY), { userId: 'u1' });
    db.onLockWait = () => {
      db.conversations = [];
    };
    await expect(purge.deleteOwned(human('u1'), 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
