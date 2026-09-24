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

import type { AiToolService } from '../ai/core/ai-tool.service';
import type { AiToolListing } from '../ai/core/tool-descriptor';
import type { AiPromptService } from '../ai/prompt/ai-prompt.module';
import type { PrismaService } from '../prisma/prisma.service';
import type { McpCaller } from './mcp-caller';
import { McpRateLimiter, WindowCounter } from './mcp-rate-limit';
import { McpServerFactory, advertisedSchema } from './mcp-server.factory';
import {
  MCP_CALL_RATE_LIMIT,
  MCP_SA_WRITE_CAP_WINDOW_MS,
  MCP_WRITE_RATE_LIMIT,
} from './mcp.constants';

const tool = (name: string, cls: AiToolListing['class']): AiToolListing => ({
  name,
  title: name,
  description: name,
  class: cls,
  inputSchema: { type: 'object', properties: {} },
  permissions: [],
  annotations: {
    readOnlyHint: cls === 'read',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
});

const CALLER: McpCaller = {
  kind: 'oauth',
  identity: { kind: 'human', userId: 'u1', sessionEpoch: 0 },
  grant: {
    id: 'g1',
    clientId: 'lzc_1',
    clientName: 'Claude Code',
    scopes: ['lazyit.read', 'lazyit.write'],
  },
  ceiling: ['read', 'write'],
  rateKey: 'grant:g1',
};

describe('McpServerFactory', () => {
  let tools: { list: jest.Mock; invoke: jest.Mock };
  let limiter: McpRateLimiter;
  let factory: McpServerFactory;
  let count: jest.Mock;

  beforeEach(() => {
    tools = {
      list: jest.fn(),
      invoke: jest.fn().mockResolvedValue({
        ok: true,
        kind: 'read',
        data: {},
        mutated: false,
        entityRefs: [],
      }),
    };
    limiter = new McpRateLimiter();
    count = jest.fn().mockResolvedValue(0);
    factory = new McpServerFactory(
      tools as unknown as AiToolService,
      { mcpInstructions: () => 'primer' } as unknown as AiPromptService,
      limiter,
      { aiToolInvocation: { count } } as unknown as PrismaService,
    );
  });

  it('lists what core lists for the caller, minus navigate, sorted by name', async () => {
    tools.list.mockResolvedValue([
      tool('z_read', 'read'),
      tool('go_to', 'navigate'),
      tool('a_write', 'write'),
    ]);
    const names = (await factory.listTools(CALLER)).map((t) => t.name);
    expect(names).toEqual(['a_write', 'z_read']);
    expect(tools.list).toHaveBeenCalledWith({
      identity: CALLER.identity,
      channel: 'MCP',
      ceiling: ['read', 'write'],
      mcp: { grantId: 'g1', clientId: 'lzc_1' },
    });
  });

  it('serves no tools without a verified caller (fail closed)', async () => {
    await factory.build(null);
    expect(tools.list).not.toHaveBeenCalled();
  });

  it('invokes through core with the caller’s context and the request id', async () => {
    await factory.call(CALLER, tool('a', 'read'), { q: 1 }, 'req-9');
    expect(tools.invoke).toHaveBeenCalledWith(
      'a',
      { q: 1 },
      expect.objectContaining({
        channel: 'MCP',
        ceiling: ['read', 'write'],
        provenance: { requestId: 'req-9' },
      }),
    );
  });

  it('rate-limits writes per caller: isError RATE_LIMITED, nothing invoked', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < MCP_WRITE_RATE_LIMIT.max; i += 1) {
      expect((await factory.call(CALLER, tool('w', 'write'), {})).isError).toBe(
        undefined,
      );
    }
    tools.invoke.mockClear();
    const refused = await factory.call(CALLER, tool('w', 'write'), {});
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'RATE_LIMITED' } },
    });
    expect(tools.invoke).not.toHaveBeenCalled();
    // Reads still pass (their own, larger budget), and another connection is unaffected.
    expect(
      (await factory.call(CALLER, tool('r', 'read'), {})).isError,
    ).toBeUndefined();
    expect(
      (
        await factory.call(
          { ...CALLER, rateKey: 'grant:other' },
          tool('w', 'write'),
          {},
        )
      ).isError,
    ).toBeUndefined();
    jest.restoreAllMocks();
  });

  describe('the per-SA maxMutationsPerRun cap, as writes per rolling hour over MCP (G3 review F2)', () => {
    const SA: McpCaller = {
      kind: 'service',
      identity: { kind: 'service', serviceAccountId: 'sa-1' },
      ceiling: ['read', 'write', 'elevated'],
      rateKey: 'sa:sa-1',
      maxWritesPerHour: 2,
    };

    it('refuses a write once the SA made its cap of writes in the last hour, counted from the ledger rows', async () => {
      const now = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      count.mockResolvedValue(2);
      const refused = await factory.call(SA, tool('w', 'write'), {});
      expect(refused).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'RATE_LIMITED' } },
      });
      expect(tools.invoke).not.toHaveBeenCalled();
      expect(count).toHaveBeenCalledWith({
        where: {
          channel: 'MCP',
          serviceAccountId: 'sa-1',
          toolClass: { in: ['write', 'elevated'] },
          createdAt: { gt: new Date(now - MCP_SA_WRITE_CAP_WINDOW_MS) },
        },
      });
      jest.restoreAllMocks();
    });

    it('lets writes through below the cap, and never counts reads', async () => {
      count.mockResolvedValue(1);
      await factory.call(SA, tool('w', 'elevated'), {});
      expect(tools.invoke).toHaveBeenCalledTimes(1);
      count.mockClear();
      count.mockResolvedValue(99);
      await factory.call(SA, tool('r', 'read'), {});
      expect(count).not.toHaveBeenCalled();
      expect(tools.invoke).toHaveBeenCalledTimes(2);
    });

    it('does not apply without a cap, nor to humans', async () => {
      count.mockResolvedValue(99);
      await factory.call(
        { ...SA, maxWritesPerHour: null },
        tool('w', 'write'),
        {},
      );
      await factory.call(
        { ...CALLER, maxWritesPerHour: 1 },
        tool('w', 'write'),
        {},
      );
      expect(count).not.toHaveBeenCalled();
      expect(tools.invoke).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the cap cannot be counted', async () => {
      count.mockRejectedValue(new Error('db down'));
      expect(await factory.call(SA, tool('w', 'write'), {})).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'RATE_LIMITED' } },
      });
      expect(tools.invoke).not.toHaveBeenCalled();
    });
  });

  it('rate-limits all calls per caller', () => {
    const now = 1_000_000;
    for (let i = 0; i < MCP_CALL_RATE_LIMIT.max; i += 1) {
      expect(limiter.call('k', false, now)).toBe(true);
    }
    expect(limiter.call('k', false, now)).toBe(false);
    // The window resets.
    expect(limiter.call('k', false, now + MCP_CALL_RATE_LIMIT.windowMs)).toBe(
      true,
    );
  });

  it('never lets a core exception escape: INTERNAL with the request id, no internals', async () => {
    tools.invoke.mockRejectedValue(new Error('db password leaked in message'));
    const result = await factory.call(CALLER, tool('a', 'read'), {}, 'req-2');
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'INTERNAL', requestId: 'req-2' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('advertises the catalog schema and hands arguments through for core to validate', () => {
    const schema = advertisedSchema({ type: 'object', required: ['q'] });
    const std = schema['~standard'];
    expect(std.jsonSchema.input({ target: 'draft-2020-12' })).toEqual({
      type: 'object',
      required: ['q'],
    });
    expect(std.validate({ anything: true })).toEqual({
      value: { anything: true },
    });
    expect(std.validate([1])).toHaveProperty('issues');
  });
});

describe('WindowCounter', () => {
  it('reports exhaustion without counting, and forgets old windows', () => {
    const counter = new WindowCounter(2, 1000);
    expect(counter.exhausted('ip', 0)).toBe(false);
    counter.hit('ip', 0);
    counter.hit('ip', 0);
    expect(counter.exhausted('ip', 10)).toBe(true);
    expect(counter.hit('ip', 10)).toBe(false);
    expect(counter.exhausted('ip', 1000)).toBe(false);
    expect(counter.hit('ip', 1000)).toBe(true);
  });
});
