import { runParseJob, type ParsePrismaClient } from './run-parse-job';
import type { ParseJobData } from './import-job.types';

/**
 * Unit tests for the pure parse-job body (ADR-0069 wave 2, #629) against a fake structural Prisma —
 * no DI, no real DB. Asserts the worker writes the rows + advances the session on success, and
 * records a FAILED session (never throws) on malformed input or an over-quota file.
 */

interface SessionUpdate {
  where: { id: string };
  data: Record<string, unknown>;
}

function makeFakePrisma() {
  const sessionUpdates: SessionUpdate[] = [];
  const insertedRows: { sessionId: string; rowIndex: number; raw: unknown }[] =
    [];
  let deleteManyCalls = 0;

  const prisma: ParsePrismaClient = {
    importSession: {
      update: async (args) => {
        sessionUpdates.push(args as SessionUpdate);
        return undefined;
      },
    },
    importRow: {
      deleteMany: async () => {
        deleteManyCalls++;
        return undefined;
      },
      createMany: async (args) => {
        insertedRows.push(...args.data);
        return undefined;
      },
    },
  };

  return { prisma, sessionUpdates, insertedRows, get deleteManyCalls() { return deleteManyCalls; } };
}

const job = (
  contentBase64: string,
  format: ParseJobData['format'],
): ParseJobData => ({ sessionId: 'sess_1', format, contentBase64 });

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

describe('runParseJob', () => {
  it('parses a CSV → inserts rows and sets the session PARSED with the detected shape', async () => {
    const fake = makeFakePrisma();
    const result = await runParseJob(
      job(b64('name,serial\nLaptop,A1\nMonitor,B2\n'), 'csv'),
      fake.prisma,
    );

    expect(result).toEqual({
      sessionId: 'sess_1',
      outcome: 'parsed',
      rowCount: 2,
    });
    expect(fake.insertedRows).toHaveLength(2);
    expect(fake.insertedRows[0]).toEqual({
      sessionId: 'sess_1',
      rowIndex: 0,
      raw: { name: 'Laptop', serial: 'A1' },
    });
    // First update → PARSING, last update → PARSED with detected headers.
    expect(fake.sessionUpdates[0].data.status).toBe('PARSING');
    const last = fake.sessionUpdates[fake.sessionUpdates.length - 1].data;
    expect(last.status).toBe('PARSED');
    expect((last.detected as { headers: string[] }).headers).toEqual([
      'name',
      'serial',
    ]);
    // Idempotency: clears any prior rows before inserting.
    expect(fake.deleteManyCalls).toBe(1);
  });

  it('parses a JSON array', async () => {
    const fake = makeFakePrisma();
    const result = await runParseJob(
      job(b64('[{"name":"X"},{"name":"Y"}]'), 'json'),
      fake.prisma,
    );
    expect(result.outcome).toBe('parsed');
    expect(fake.insertedRows).toHaveLength(2);
  });

  it('collects up to 4 distinct non-empty sample values per column [REDESIGN §4.2]', async () => {
    const fake = makeFakePrisma();
    // colA has 5 distinct values (capped at 4) + a repeat + a blank; colB has a blank + repeats.
    await runParseJob(
      job(
        b64('colA,colB\na1,b1\na2,b1\na3,\na4,b2\na5,b1\na1, \n'),
        'csv',
      ),
      fake.prisma,
    );
    const last = fake.sessionUpdates[fake.sessionUpdates.length - 1].data;
    const samples = (last.detected as { samples: Record<string, string[]> }).samples;
    // colA: first 4 DISTINCT non-empty values, in first-seen order (a5 + the a1 repeat are dropped).
    expect(samples.colA).toEqual(['a1', 'a2', 'a3', 'a4']);
    // colB: blank + whitespace cells are skipped (coerceAbsent); only distinct non-empty values kept.
    expect(samples.colB).toEqual(['b1', 'b2']);
  });

  it('records FAILED (never throws) on malformed input — a non-array JSON', async () => {
    const fake = makeFakePrisma();
    const result = await runParseJob(job(b64('42'), 'json'), fake.prisma);

    expect(result.outcome).toBe('failed');
    expect(result.rowCount).toBe(0);
    expect(fake.insertedRows).toHaveLength(0);
    const last = fake.sessionUpdates[fake.sessionUpdates.length - 1].data;
    expect(last.status).toBe('FAILED');
    expect((last.error as { message: string }).message).toMatch(
      /array of records|object/i,
    );
  });

  it('records FAILED on a header-only CSV (no data rows)', async () => {
    const fake = makeFakePrisma();
    const result = await runParseJob(
      job(b64('name,serial\n'), 'csv'),
      fake.prisma,
    );
    expect(result.outcome).toBe('failed');
    expect(fake.insertedRows).toHaveLength(0);
  });

  it('records FAILED when the row count exceeds the quota (SEC-001)', async () => {
    const original = process.env.MAX_IMPORT_ROWS;
    process.env.MAX_IMPORT_ROWS = '1';
    try {
      const fake = makeFakePrisma();
      const result = await runParseJob(
        job(b64('name\nA\nB\nC\n'), 'csv'),
        fake.prisma,
      );
      expect(result.outcome).toBe('failed');
      expect(fake.insertedRows).toHaveLength(0);
      const last = fake.sessionUpdates[fake.sessionUpdates.length - 1].data;
      expect(last.status).toBe('FAILED');
      expect((last.error as { message: string }).message).toMatch(/limit/i);
    } finally {
      if (original === undefined) delete process.env.MAX_IMPORT_ROWS;
      else process.env.MAX_IMPORT_ROWS = original;
    }
  });
});
