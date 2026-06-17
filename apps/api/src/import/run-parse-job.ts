import { maxImportRows, parseImport } from './parser';
import type { ParseJobData, ParseJobResult } from './import-job.types';

/**
 * The PURE parse-job body (ADR-0069 wave 2). Extracted from the sandboxed processor so it can run
 * against any structurally-compatible Prisma client — the real `PrismaClient` in the forked child,
 * or a fake in a Jest spec — with NO Nest DI. Mirrors `articles/import/create-imported-article.ts`.
 *
 * It decodes + parses the file, enforces the record-count quota (SEC-001), then writes the outcome to
 * PostgreSQL (the system of record): on success the `ImportRow`s + session → `PARSED`; on a malformed
 * file the session → `FAILED` with a recorded error and NO rows. It NEVER throws on bad INPUT — only a
 * genuine infrastructure failure (DB down) propagates and fails the job.
 */

/** The minimal slice of Prisma this job needs — the real client satisfies it structurally. */
export interface ParsePrismaClient {
  importSession: {
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  importRow: {
    deleteMany(args: { where: { sessionId: string } }): Promise<unknown>;
    createMany(args: {
      data: { sessionId: string; rowIndex: number; raw: unknown }[];
    }): Promise<unknown>;
  };
}

/**
 * How many `ImportRow`s to insert per `createMany` call. Parsing produces all rows in memory (bounded
 * by the size cap + row quota), but a single mega-insert can blow the Postgres parameter limit and
 * spike memory; chunked inserts keep both bounded. Pure data — no behavioral coupling.
 */
const ROW_INSERT_CHUNK = 1000;

/** A FAILED session carries a structured, PII-free error blob (matches the ImportRow `error` shape). */
function failureBlob(reason: string): { phase: 'parse'; message: string } {
  return { phase: 'parse', message: reason };
}

export async function runParseJob(
  data: ParseJobData,
  prisma: ParsePrismaClient,
): Promise<ParseJobResult> {
  const { sessionId, format } = data;

  // Mark PARSING up front so a crash mid-parse leaves an observable state (the child can be OOM-killed
  // by a bomb after this point; the session then reads PARSING until the GC sweep or a re-run).
  await prisma.importSession.update({
    where: { id: sessionId },
    data: { status: 'PARSING' },
  });

  const buffer = Buffer.from(data.contentBase64, 'base64');
  const result = parseImport(buffer, format);

  if (!result.ok) {
    // Malformed-but-present input → graceful FAILED, never a thrown crash (ADR-0069 acceptance).
    await prisma.importSession.update({
      where: { id: sessionId },
      data: {
        status: 'FAILED',
        error: failureBlob(result.reason),
      },
    });
    return { sessionId, outcome: 'failed', rowCount: 0 };
  }

  // SEC-001 record-count quota: a small file can still describe a huge number of rows. Refuse rather
  // than materialize unbounded ImportRows.
  const cap = maxImportRows();
  if (result.rowCount > cap) {
    await prisma.importSession.update({
      where: { id: sessionId },
      data: {
        status: 'FAILED',
        error: failureBlob(
          `The file has ${result.rowCount} rows, over the ${cap}-row import limit. Split it into smaller files.`,
        ),
      },
    });
    return { sessionId, outcome: 'failed', rowCount: 0 };
  }

  // Idempotency: a re-run (BullMQ attempt or a manual re-parse) clears any prior rows first so we
  // never double-insert. Parse is `attempts:1`, but a stalled-then-respawned child is still possible.
  await prisma.importRow.deleteMany({ where: { sessionId } });

  for (let i = 0; i < result.rows.length; i += ROW_INSERT_CHUNK) {
    const chunk = result.rows.slice(i, i + ROW_INSERT_CHUNK);
    await prisma.importRow.createMany({
      data: chunk.map((raw, j) => ({
        sessionId,
        rowIndex: i + j,
        raw,
      })),
    });
  }

  // PARSED: rows materialized, headers known. The detected shape is stamped on the session so the
  // map step can render the column list without re-reading the (now discarded) file.
  await prisma.importSession.update({
    where: { id: sessionId },
    data: {
      status: 'PARSED',
      detected: {
        headers: result.headers,
        dialect: result.dialect,
        encoding: result.encoding,
        rowCount: result.rowCount,
      },
    },
  });

  return { sessionId, outcome: 'parsed', rowCount: result.rowCount };
}
