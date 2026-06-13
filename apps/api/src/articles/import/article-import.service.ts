import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  ImportArticle,
  ImportJobAccepted,
  ImportJobState,
  ImportJobStatus,
  ZipImportResult,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { isServicePrincipal, type Principal } from '../../auth/principal';
import {
  ALL_IMPORT_EXTENSIONS,
  extensionOf,
  isZipImport,
  maxImportBytes,
  maxImportMb,
} from '../article-import';
import {
  ARTICLE_IMPORT_JOB_NAME,
  ARTICLE_IMPORT_QUEUE,
} from './import-job.constants';
import { isQueueUnavailableError } from '../../queue/redis-connection';
import type {
  ImportJobData,
  ImportJobResult,
  UploadedImportFile,
} from './import-job.types';

/**
 * Async article import (ADR-0053 / ADR-0059 §5). The HTTP request does only fast, safe validation
 * (author/type/size/category) and then enqueues a job, returning 202 + a `jobId`; the heavy,
 * potentially hostile `.docx`/`.zip` parse and the Article create(s) happen later in the sandboxed
 * worker child (SEC-002). A `.zip` rides the SAME queue + child + bomb-guard class but FANS OUT to
 * many articles (selective extraction + folder mirroring); its per-item outcome is surfaced under
 * `ImportJobStatus.batch`. The web client polls {@link getStatus}. PostgreSQL is the system of
 * record; the queue is only transport, so the polling state is read straight from BullMQ.
 */
@Injectable()
export class ArticleImportService {
  constructor(
    @InjectQueue(ARTICLE_IMPORT_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Validate the upload SYNCHRONOUSLY (a human author, a supported extension, the size cap, a live
   * category), then enqueue an `article-import` job. Returns the `jobId` the client polls. The file
   * bytes ride along base64-encoded — already ≤ MAX_IMPORT_SIZE_MB; the dangerous expansion (a
   * `.docx` decompression OR a `.zip` unpack) happens in the child. A `.zip` is tagged `kind: 'zip'`
   * so the worker takes the bulk fan-out path (ADR-0059 §5).
   */
  async enqueue(
    file: UploadedImportFile | undefined,
    fields: ImportArticle,
    principal?: Principal,
  ): Promise<ImportJobAccepted> {
    const authorId = this.resolveAuthor(principal);
    if (!file) {
      throw new BadRequestException('A file is required');
    }
    // Defense in depth behind the interceptor's hard cap (SEC-001): a limit-compliant upload only.
    // This bounds the COMPRESSED upload; a `.zip`'s uncompressed expansion is bounded separately by
    // the worker's entry-count/uncompressed-size quota inside the sandboxed child (ADR-0059 §5).
    if (file.size > maxImportBytes()) {
      throw new BadRequestException(
        `File exceeds the ${maxImportMb()} MB import limit`,
      );
    }
    const ext = extensionOf(file.originalname);
    if (!(ALL_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `Unsupported file type "${ext ? '.' + ext : '(none)'}". Supported: ${ALL_IMPORT_EXTENSIONS.map(
          (e) => '.' + e,
        ).join(', ')}.`,
      );
    }
    const isZip = isZipImport(file.originalname);
    // Fail fast on a bad category — the worker would otherwise fail the job on the FK. For a `.zip`
    // this is the ROOT home folder under which the mirrored tree is grafted.
    await this.assertCategoryUsable(fields.categoryId);

    const data: ImportJobData = {
      originalname: file.originalname,
      contentBase64: file.buffer.toString('base64'),
      categoryId: fields.categoryId,
      status: fields.status,
      // title/slug apply only to a single-file import; a `.zip` derives each per entry, so they are
      // dropped for the bulk path.
      ...(!isZip && fields.title !== undefined ? { title: fields.title } : {}),
      ...(!isZip && fields.slug !== undefined ? { slug: fields.slug } : {}),
      authorId,
      ...(isZip ? { kind: 'zip' as const } : {}),
    };

    // Enqueue. With `enableOfflineQueue: false` on the broker connection (issue #257), a queue.add
    // against an unreachable Valkey REJECTS immediately instead of buffering the job forever — so we
    // translate that into a clean 503 here. Without this the POST hung as a 202 that never resolved.
    let job;
    try {
      job = await this.queue.add(ARTICLE_IMPORT_JOB_NAME, data, {
        // A parse / bomb failure is PERMANENT — retrying would just kill another child (SEC-002).
        attempts: 1,
        // Keep finished jobs pollable for a while, but bound the set (the queue is transport, not the
        // system of record). Failures linger longer so the user can read the outcome.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      });
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        // 503: a clear "try again later", never the raw connection error (ADR-0031).
        throw new ServiceUnavailableException(
          'The import service is temporarily unavailable (the job queue is unreachable). Please try again in a moment.',
        );
      }
      throw err;
    }
    if (!job.id) {
      // Should never happen (BullMQ always assigns an id); fail loudly rather than return a bad handle.
      throw new Error('Failed to enqueue import job (no job id assigned)');
    }
    return { jobId: job.id };
  }

  /**
   * Poll an import job. 404 for an unknown id. On a completed SINGLE-file import `articleId` is set;
   * on a completed `.zip` import `batch` carries the per-item outcome (created/renamed/skipped) while
   * `articleId` stays null (a bulk import has no single id). `error` is a short, PERMANENT-failure
   * message only once failed (never "try again" — a parse/bomb/over-quota failure won't succeed on a
   * retry). (ADR-0059 §5)
   */
  async getStatus(jobId: string): Promise<ImportJobStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Import job ${jobId} not found`);
    }
    const state = this.mapState(await job.getState());
    const result =
      state === 'completed'
        ? (job.returnvalue as ImportJobResult | undefined)
        : undefined;
    // Discriminate the result by `kind`. A legacy single result has no `kind` ⇒ treat as single.
    const isZipResult = result?.kind === 'zip';
    const articleId =
      result && !isZipResult ? (result.articleId ?? null) : null;
    const batch: ZipImportResult | null =
      result && isZipResult ? result.batch : null;
    const error =
      state === 'failed' ? this.friendlyError(job.failedReason) : null;
    return { jobId, state, articleId, batch, error };
  }

  /** Collapse BullMQ's internal states to the four the client observes. */
  private mapState(state: string): ImportJobState {
    switch (state) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'active':
        return 'active';
      // waiting | delayed | prioritized | waiting-children | unknown
      default:
        return 'queued';
    }
  }

  /**
   * Map a raw BullMQ `failedReason` to a short, friendly, PERMANENT message. We never echo internal
   * stack/queue noise (ADR-0031) and never imply the import might succeed later — a malformed file or
   * a decompression bomb is a permanent failure.
   */
  private friendlyError(reason: string | undefined): string {
    const r = reason ?? '';
    // A STALLED job (issue #257): the worker picked the job up (active) but its lock expired before
    // completion — e.g. the sandboxed child was OOM-killed by a `.docx` bomb (SEC-002), or it hung.
    // BullMQ's stalled-job checker (lockDuration/maxStalledCount defaults) moves it to `failed` after
    // `maxStalledCount` so it can never hang forever. Unlike a parse failure this CAN be retried.
    if (r.includes('stalled')) {
      return 'The import timed out while processing and was cancelled. Please try again.';
    }
    if (r.includes('no text content')) {
      return 'The file has no readable text content.';
    }
    if (r.includes('Unsupported file type')) {
      return 'That file type is not supported. Use a .md, .txt, .docx or .zip file.';
    }
    // The `.zip` bomb-guard QUOTA arm (ADR-0059 §5): too many entries or too much uncompressed text.
    // Permanent — the archive itself is over the limit, not a transient hiccup.
    if (r.includes('import limit') && (r.includes('entries') || r.includes('uncompressed'))) {
      return 'The .zip archive is too large to import — it has too many files or too much uncompressed content.';
    }
    if (r.includes('not a zip file') || r.includes('read the .zip')) {
      return 'We could not read this .zip archive. It may be corrupt or not a valid zip file.';
    }
    // Everything else — a corrupt/malformed .docx, a decompression bomb that OOM-killed the child,
    // or any other parse failure — is permanent and not safe to detail.
    return 'We could not import this file. It may be corrupt, malformed, or too complex to process.';
  }

  /**
   * Resolve the human author from the principal (ADR-0022/0048). A service account cannot author an
   * article (403); an unauthenticated caller is rejected (400). Mirrors
   * `ArticlesService.requireAuthor` — the import author is the caller, never a body value.
   */
  private resolveAuthor(principal?: Principal): string {
    if (isServicePrincipal(principal)) {
      throw new ForbiddenException(
        'Service accounts cannot import articles (an article author is a human user)',
      );
    }
    const resolved = principal?.user.id;
    if (!resolved) {
      throw new BadRequestException(
        'An authenticated user is required for this operation',
      );
    }
    return resolved;
  }

  /** 400 if categoryId doesn't reference a live (non-soft-deleted) category. */
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.prisma.articleCategory.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException(
        `categoryId ${categoryId} does not reference a live category`,
      );
    }
  }
}
