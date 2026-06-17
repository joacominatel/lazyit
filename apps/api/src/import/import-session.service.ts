import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { ImportEntity } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isQueueUnavailableError } from '../queue/redis-connection';
import {
  IMPORT_PARSE_JOB_NAME,
  IMPORT_PARSE_QUEUE,
} from './import-job.constants';
import type { ParseJobData, UploadedImportFile } from './import-job.types';
import type { ImportFormat } from './parser';

/**
 * The migrator INGEST session service (ADR-0069 wave 2, #629). Owns the `ImportSession`/`ImportRow`
 * lifecycle for the PARSE step only: create a session, enqueue the sandboxed parse job, and read a
 * session (owner-scoped) with its rows + a summary. The map/dry-run/commit steps and the user-facing
 * HTTP controllers + `import:run` permission are LATER WAVES (this service is driven by a method +
 * the worker, and by Jest with in-memory buffers — ADR-0069 §10, issue #629 out-of-scope).
 *
 * SECURITY: every read is OWNER-SCOPED (no IDOR — ADR-0069 §11): a session belongs to the human who
 * created it, and `getForOwner` filters by `ownerId`. Logs stay PII-free (counts/headers only).
 */

/** Session TTL — the wizard is short-lived; a GC sweeper hard-deletes expired sessions (later wave). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Map the @lazyit/shared lowercase entity literal to the Prisma uppercase enum member. */
const PRISMA_ENTITY: Record<ImportEntity, 'ASSET'> = { asset: 'ASSET' };

/** A created session handle the caller can poll. */
export interface CreatedImportSession {
  sessionId: string;
}

/** The detected source shape stamped on the session by the parse worker (jsonb). */
export interface DetectedShape {
  headers: string[];
  dialect: { delimiter: string | null; hadBom: boolean };
  encoding: string;
  rowCount: number;
}

/** A session read with its rows + an at-a-glance summary (owner-scoped). */
export interface ImportSessionWithRows {
  id: string;
  entity: ImportEntity;
  status: string;
  detected: DetectedShape | null;
  error: { phase: string; message: string } | null;
  rowCount: number;
  headers: string[];
  rows: { rowIndex: number; status: string; raw: Record<string, string> }[];
}

@Injectable()
export class ImportSessionService {
  constructor(
    @InjectQueue(IMPORT_PARSE_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Create a PENDING session owned by `ownerId` for `entity`, then enqueue the sandboxed parse job
   * with the (size-capped) file bytes. The file is hashed for the audit/idempotency correlation
   * (§9) — the hash, never the contents, is stored. Returns the `sessionId` to poll. The parse +
   * row materialization happen in the worker child.
   */
  async createAndParse(
    ownerId: string,
    entity: ImportEntity,
    format: ImportFormat,
    file: UploadedImportFile,
  ): Promise<CreatedImportSession> {
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const session = await this.prisma.importSession.create({
      data: {
        entity: PRISMA_ENTITY[entity],
        status: 'PENDING',
        ownerId,
        fileHash,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
      select: { id: true },
    });

    const data: ParseJobData = {
      sessionId: session.id,
      format,
      contentBase64: file.buffer.toString('base64'),
    };

    try {
      await this.queue.add(IMPORT_PARSE_JOB_NAME, data, {
        // A parse failure is PERMANENT (a malformed file won't parse on a retry) — and a re-run would
        // just kill another child if it was a bomb (SEC-002). The worker records FAILED on the session.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        // The broker is down — mark the session FAILED so it doesn't sit PENDING forever, then 503.
        await this.prisma.importSession
          .update({
            where: { id: session.id },
            data: {
              status: 'FAILED',
              error: {
                phase: 'enqueue',
                message: 'The import queue was unavailable; please try again.',
              },
            },
          })
          .catch(() => undefined);
        throw new ServiceUnavailableException(
          'The import service is temporarily unavailable (the job queue is unreachable). Please try again in a moment.',
        );
      }
      throw err;
    }

    return { sessionId: session.id };
  }

  /**
   * Read a session owned by `ownerId` with its rows + summary. 404 for an unknown id OR a session
   * owned by someone else (owner-scoped — no IDOR, and we never reveal another owner's session
   * exists). `rows` are returned in source order; `headers` come from the detected shape.
   */
  async getForOwner(
    sessionId: string,
    ownerId: string,
  ): Promise<ImportSessionWithRows> {
    const session = await this.prisma.importSession.findFirst({
      where: { id: sessionId, ownerId },
      select: {
        id: true,
        entity: true,
        status: true,
        detected: true,
        error: true,
        rows: {
          orderBy: { rowIndex: 'asc' },
          select: { rowIndex: true, status: true, raw: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException(`Import session ${sessionId} not found`);
    }

    const detected = (session.detected as DetectedShape | null) ?? null;
    return {
      id: session.id,
      // Map the Prisma uppercase enum back to the shared lowercase literal.
      entity: session.entity.toLowerCase() as ImportEntity,
      status: session.status,
      detected,
      error: (session.error as { phase: string; message: string } | null) ?? null,
      rowCount: session.rows.length,
      headers: detected?.headers ?? [],
      rows: session.rows.map((r) => ({
        rowIndex: r.rowIndex,
        status: r.status,
        raw: r.raw as Record<string, string>,
      })),
    };
  }
}
