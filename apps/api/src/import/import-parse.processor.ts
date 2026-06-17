import { PrismaPg } from '@prisma/adapter-pg';
import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '../../generated/prisma/client';
import type { ParseJobData, ParseJobResult } from './import-job.types';
import { runParseJob, type ParsePrismaClient } from './run-parse-job';

/**
 * BullMQ SANDBOXED processor for the `import-parse` queue (ADR-0069 wave 2 / ADR-0053). BullMQ forks
 * this file into a SEPARATE Node child launched with `--max-old-space-size` (see import-job.constants.ts
 * / import.module.ts). A pathological CSV/JSON (a quoted field of gigabytes, a deeply nested blob)
 * expands past the cap and OOMs THIS child — BullMQ marks the job `failed` and respawns a fresh child;
 * the API process is never touched (SEC-002). The record-count quota (SEC-001) sits in `runParseJob`
 * in front of the row inserts. The file bytes ride in the job (base64) and are discarded with the job.
 *
 * The child has no Nest DI container, so it owns its own PrismaClient (PostgreSQL is the system of
 * record — the worker writes the ImportRows + advances the session status). It must export the
 * processor via `module.exports` per the BullMQ sandbox contract.
 */

let prismaSingleton: PrismaClient | undefined;

/** One PrismaClient per child, reused across jobs. */
function getPrisma(): PrismaClient {
  if (!prismaSingleton) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    prismaSingleton = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }
  return prismaSingleton;
}

const processor = async (
  job: SandboxedJob<ParseJobData>,
): Promise<ParseJobResult> => {
  const prisma = getPrisma() as unknown as ParsePrismaClient;
  return runParseJob(job.data, prisma);
};

// A BullMQ sandboxed processor file must export the handler as the module's value. `export =` emits a
// plain CommonJS `module.exports = processor`, which BullMQ's child loader resolves. Per the sandbox
// contract this is the file's only export.
export = processor;
