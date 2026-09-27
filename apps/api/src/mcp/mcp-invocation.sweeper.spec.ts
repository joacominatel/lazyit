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
import type { PrismaService } from '../prisma/prisma.service';
import { McpInvocationSweeper } from './mcp-invocation.sweeper';
import { MCP_EXECUTING_STALE_AFTER_MS, MCP_SWEEP_BATCH } from './mcp.constants';

describe('McpInvocationSweeper — interrupted MCP writes become OUTCOME_UNKNOWN (W2-0 follow-up)', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  let findMany: jest.Mock;
  let markOutcomeUnknown: jest.Mock;
  let sweeper: McpInvocationSweeper;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([{ id: 'inv1' }, { id: 'inv2' }]);
    markOutcomeUnknown = jest
      .fn()
      .mockResolvedValueOnce({ id: 'inv1' })
      .mockResolvedValueOnce(null);
    sweeper = new McpInvocationSweeper(
      { aiToolInvocation: { findMany } } as unknown as PrismaService,
      { markOutcomeUnknown } as unknown as AiToolService,
    );
  });

  it('selects only MCP invocations stuck EXECUTING past the threshold, outside any run', async () => {
    expect(await sweeper.sweep(now)).toBe(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        channel: 'MCP',
        status: 'EXECUTING',
        runId: null,
        updatedAt: {
          lt: new Date(now.getTime() - MCP_EXECUTING_STALE_AFTER_MS),
        },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: MCP_SWEEP_BATCH,
    });
    // Through core's primitive: FAILED/UNKNOWN_OUTCOME in the ledger, never retried.
    expect(markOutcomeUnknown.mock.calls).toEqual([['inv1'], ['inv2']]);
  });

  it('keeps going when one row fails, and never throws', async () => {
    markOutcomeUnknown
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'inv2' });
    expect(await sweeper.sweep(now)).toBe(1);
    findMany.mockRejectedValue(new Error('db down'));
    await expect(sweeper.sweep(now)).resolves.toBe(0);
  });

  it('is re-entrancy guarded', async () => {
    let release: () => void = () => undefined;
    findMany.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );
    const first = sweeper.sweep(now);
    expect(await sweeper.sweep(now)).toBe(0);
    release();
    await first;
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does not start its timer under NODE_ENV=test', () => {
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    expect(findMany).not.toHaveBeenCalled();
  });
});
