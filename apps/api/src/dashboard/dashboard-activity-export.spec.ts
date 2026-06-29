import {
  ACTIVITY_EXPORT_BATCH_SIZE,
  DashboardService,
} from './dashboard.service';
import { RECENT_ACTIVITY_CSV_HEADER } from '@lazyit/shared';
import type { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the suite never loads the real one (no DB). The service touches
// it at runtime only for `Prisma.sql` / `Prisma.join` / `Prisma.empty`, which compose the export query
// + the parameterized WHERE — a tiny faithful builder is enough (each fragment just captures its text).
jest.mock('../../generated/prisma/client', () => {
  class FakeSql {
    constructor(
      readonly strings: readonly string[],
      readonly values: readonly unknown[],
    ) {}
  }
  const EMPTY = new FakeSql([''], []);
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): FakeSql =>
    new FakeSql(Array.from(strings), values);
  const join = (): FakeSql => EMPTY;
  return { PrismaClient: class {}, Prisma: { sql, join, empty: EMPTY } };
});

/**
 * Unit spec for the bulk activity CSV export (issue #840): the output-boundary security guard and the
 * batching loop's termination. PrismaService is a tiny stub whose `$queryRaw` returns canned batches,
 * so we exercise {@link DashboardService.streamActivityCsvRows} without a database.
 */
describe('DashboardService.streamActivityCsvRows (bulk filtered export, issue #840)', () => {
  // A row crafted to exercise BOTH output-boundary guards at once:
  //  - actorName starts with '=' → spreadsheet formula-injection (must be defused with a leading ')
  //  - summary holds a comma + a double-quote + a newline → RFC-4180 quote-wrap with quotes doubled
  const maliciousRow = {
    occurredAt: new Date('2026-05-31T12:00:00.000Z'),
    actorId: '11111111-1111-4111-8111-111111111111',
    actorName: '=cmd|/c calc',
    entityType: 'asset' as const,
    entityId: 'casset0000000000000000001',
    action: 'created',
    summary: 'a,b "q"\nz',
    subjectName: null,
    targetUserId: null,
    targetUserName: null,
  };

  async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of gen) out += chunk;
    return out;
  }

  it('escapes injection/quoting at the boundary and terminates after a full batch then an empty one', async () => {
    const queryRaw = jest.fn();
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const service = new DashboardService(prisma);

    // First read returns a FULL batch (length === ACTIVITY_EXPORT_BATCH_SIZE) so the loop MUST fetch
    // again; the second (empty) read is what stops it. Proves both the escaping and that the bounded
    // OFFSET loop terminates (no infinite loop on a perfectly-full final page).
    const fullBatch = Array.from(
      { length: ACTIVITY_EXPORT_BATCH_SIZE },
      () => maliciousRow,
    );
    queryRaw.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([]);

    const csv = await collect(service.streamActivityCsvRows({}));

    // Exactly two reads: the full batch, then the empty one that ends the loop.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    // Header first.
    expect(csv.startsWith(`${RECENT_ACTIVITY_CSV_HEADER}\n`)).toBe(true);
    // Formula-injection defused: the '=' cell is prefixed with a single quote.
    expect(csv).toContain("'=cmd|/c calc");
    // RFC-4180: comma/quote/newline cell is quote-wrapped with embedded quotes doubled.
    expect(csv).toContain('"a,b ""q""\nz"');
    // Every row of the full batch was serialized (one defused actorName per row).
    expect(csv.split("'=cmd|/c calc").length - 1).toBe(
      ACTIVITY_EXPORT_BATCH_SIZE,
    );
  });
});
