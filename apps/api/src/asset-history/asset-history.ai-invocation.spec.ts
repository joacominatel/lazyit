// The generated Prisma client is only used for types by the service; keep the real one from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { runInAiInvocation } from '../ai/core/invocation-context';
import { AssetHistoryService } from './asset-history.service';

/**
 * AI provenance (ADR-0097, R6): a row written while an AI tool call executes carries that call's
 * `aiInvocationId`, read from the AsyncLocalStorage context — through awaits and a transaction callback —
 * and a row written outside one carries none (the column stays null, as for every existing writer).
 */
describe('AssetHistoryService — aiInvocationId stamp', () => {
  const EVENT = { assetId: 'a1', eventType: 'STATUS_CHANGED' as const };

  function writer() {
    return { assetHistory: { create: jest.fn().mockResolvedValue({}) } };
  }

  function writtenData(client: ReturnType<typeof writer>) {
    const calls = client.assetHistory.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    return calls[0][0].data;
  }

  const service = new AssetHistoryService({} as never);

  it('stamps the current AI invocation id', async () => {
    const client = writer();
    await runInAiInvocation(
      { invocationId: 'inv-1', channel: 'HEADLESS' },
      () => service.record(client, EVENT),
    );
    expect(writtenData(client).aiInvocationId).toBe('inv-1');
  });

  it('keeps the stamp across awaits and inside a transaction-style callback', async () => {
    const client = writer();
    const transaction = async <T>(fn: (tx: typeof client) => Promise<T>) => {
      await new Promise((resolve) => setImmediate(resolve));
      return fn(client);
    };
    await runInAiInvocation(
      { invocationId: 'inv-2', channel: 'MCP' },
      async () => {
        await Promise.resolve();
        await transaction((tx) => service.record(tx, EVENT));
      },
    );
    expect(writtenData(client).aiInvocationId).toBe('inv-2');
  });

  it('writes no aiInvocationId outside an AI tool call', async () => {
    const client = writer();
    await service.record(client, EVENT);
    expect(writtenData(client)).not.toHaveProperty('aiInvocationId');
  });
});
