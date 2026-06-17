import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ImportCommitService } from './import-commit.service';
import { IMPORT_COMMIT_QUEUE } from './import-commit.constants';
import type { CommitJobData, CommitJobResult } from './import-commit.types';

/**
 * The IN-PROCESS BullMQ worker for the `import-commit` queue (ADR-0069 wave 4a, #633). In-process (NOT
 * a sandboxed forked child like the PARSE worker) because the commit MUST route every write through the
 * Nest-DI `AssetsService.create()` to preserve the CREATED history, actor attribution and asset-tag
 * invariants — a DI-less forked child couldn't. There is no untrusted-file-bomb surface at commit time
 * (the bytes were parsed + discarded in wave 2), so the bomb isolation that justified a forked PARSE
 * child does not apply here (ADR-0069 §10). Mirrors the workflow-run worker.
 *
 * Concurrency 1: the commit is a long, write-heavy replay; serializing keeps DB/memory pressure bounded
 * and avoids two jobs racing the same session's rows. The commit itself is idempotent (resumable — a
 * re-run skips COMMITTED rows), so a BullMQ retry replays cleanly.
 */
@Processor(IMPORT_COMMIT_QUEUE, { concurrency: 1 })
export class ImportCommitWorker extends WorkerHost {
  private readonly logger = new Logger(ImportCommitWorker.name);

  constructor(
    private readonly commitService: ImportCommitService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<CommitJobData>): Promise<CommitJobResult> {
    const { sessionId, actorUserId } = job.data;
    try {
      return await this.commitService.commit(
        sessionId,
        actorUserId,
        (p) => void job.updateProgress({ phase: 'commit', ...p }),
      );
    } catch (err) {
      // An UNEXPECTED orchestration fault (not a per-row failure — those are isolated + recorded). Mark
      // the session FAILED so it never sits COMMITTING forever; per-row keep-partial means anything
      // already COMMITTED is durable and a re-run resumes. PII-free reason.
      this.logger.error(
        `import-commit job for session ${sessionId} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.failSessionSafely(sessionId);
      throw err;
    }
  }

  private async failSessionSafely(sessionId: string): Promise<void> {
    try {
      await this.prisma.importSession.updateMany({
        where: { id: sessionId, status: 'COMMITTING' },
        data: {
          status: 'FAILED',
          error: { phase: 'commit', message: 'commit job failed' },
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to finalize session ${sessionId} after a commit error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
