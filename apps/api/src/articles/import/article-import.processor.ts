import { PrismaPg } from '@prisma/adapter-pg';
import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '../../../generated/prisma/client';
import type { ArticleRow } from '../../search/search.documents';
import {
  runAnyImportJob,
  type ResolveImportedContent,
} from './create-imported-article';
import { rewriteEmbeddedImages } from '../../attachments/attachment-ingest';
import type { ImportJobData, ImportJobResult } from './import-job.types';

/**
 * BullMQ SANDBOXED processor for the `article-import` queue (ADR-0053). BullMQ forks this file into
 * a SEPARATE Node child process, launched with `--max-old-space-size` (see import-job.constants.ts /
 * articles.module.ts). A `.docx` OR `.zip` decompression bomb expands far past the cap and OOMs THIS
 * child — BullMQ records the job as `failed` and respawns a fresh child; the API process is never
 * touched (SEC-002). A `.zip` is the SAME ZIP threat class, with an extra entry-count/uncompressed-
 * size quota in front of the heap cap (ADR-0059 §5). md/txt are read verbatim and need no isolation,
 * but flow through the same queue for a uniform UX.
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
  const prisma = getPrisma();
  // Embedded-image round-trip (ADR-0082 §5): turn each `data:` image in the produced body (mammoth
  // inlines every embedded .docx image as one; a hand-written .md can too) into an attachment bound
  // to the article, rewriting the ref to `attachment:<id>`. Runs the untrusted image bytes through
  // the SAME sniff + re-encode + quota path an upload uses — here, in this already-sandboxed child
  // (SEC-002). The article author (a human, resolved at enqueue) owns the minted attachments.
  const resolveContent: ResolveImportedContent = async (articleId, content) =>
    (await rewriteEmbeddedImages(prisma, articleId, job.data.authorId, content))
      .content;
  // Dispatch by job kind: a single file (.md/.txt/.docx) → one Article, a .zip → the bulk fan-out
  // (selective extraction, folder mirroring, slug auto-suffix, link rewire — ADR-0059 §5).
  return runAnyImportJob(job.data, prisma, indexArticle, resolveContent);
};

// A BullMQ sandboxed processor file must export the handler as the module's value. `export =` emits a
// plain CommonJS `module.exports = processor`, which BullMQ's child loader resolves (it reads the CJS
// default export). Per the sandbox contract this is the file's only export.
export = processor;
