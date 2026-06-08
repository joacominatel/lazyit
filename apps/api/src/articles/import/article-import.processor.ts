import { PrismaPg } from '@prisma/adapter-pg';
import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '../../../generated/prisma/client';
import type { ArticleRow } from '../../search/search.documents';
import {
  runImportJob,
  type ImportPrismaClient,
} from './create-imported-article';
import type { ImportJobData, ImportJobResult } from './import-job.types';

/**
 * BullMQ SANDBOXED processor for the `article-import` queue (ADR-0053). BullMQ forks this file into
 * a SEPARATE Node child process, launched with `--max-old-space-size` (see import-job.constants.ts /
 * articles.module.ts). A `.docx` decompression bomb expands far past the cap and OOMs THIS child —
 * BullMQ records the job as `failed` and respawns a fresh child; the API process is never touched
 * (SEC-002). md/txt are read verbatim and need no isolation, but flow through the same queue for a
 * uniform UX.
 *
 * The child has no Nest DI container, so it owns its own PrismaClient (the system of record stays
 * PostgreSQL) and a best-effort Meili indexer built from env. It must export the processor via
 * `module.exports`/default per the BullMQ sandbox contract.
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

/**
 * Best-effort search indexer for a PUBLISHED imported article. Mirrors `SearchService.upsert`
 * (addDocuments by primary key) but is self-contained so the lean child needs no Nest DI. No-op when
 * `MEILI_HOST` is unset. Loads the ESM Meili client lazily so importing this module never pulls it
 * in (keeping the child's baseline heap small for SEC-002).
 */
async function indexArticle(doc: ArticleRow): Promise<void> {
  const host = process.env.MEILI_HOST;
  if (!host) return;
  const apiKey = process.env.MEILI_MASTER_KEY;
  const { Meilisearch } = await import('meilisearch');
  const client = new Meilisearch({ host, apiKey });
  await client.index('articles').addDocuments([doc], { primaryKey: 'id' });
}

const processor = async (
  job: SandboxedJob<ImportJobData>,
): Promise<ImportJobResult> => {
  const prisma = getPrisma() as unknown as ImportPrismaClient;
  return runImportJob(job.data, prisma, indexArticle);
};

// A BullMQ sandboxed processor file must export the handler as the module's value. `export =` emits a
// plain CommonJS `module.exports = processor`, which BullMQ's child loader resolves (it reads the CJS
// default export). Per the sandbox contract this is the file's only export.
export = processor;
