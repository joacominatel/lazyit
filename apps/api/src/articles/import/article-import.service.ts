import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  ImportArticle,
  ImportJobAccepted,
  ImportJobState,
  ImportJobStatus,
} from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { isServicePrincipal, type Principal } from '../../auth/principal';
import {
  extensionOf,
  maxImportBytes,
  maxImportMb,
  SUPPORTED_EXTENSIONS,
} from '../article-import';
import {
  ARTICLE_IMPORT_JOB_NAME,
  ARTICLE_IMPORT_QUEUE,
} from './import-job.constants';
import type {
  ImportJobData,
  ImportJobResult,
  UploadedImportFile,
} from './import-job.types';

/**
 * Async article import (ADR-0053). The HTTP request does only fast, safe validation
 * (author/type/size/category) and then enqueues a job, returning 202 + a `jobId`; the heavy,
 * potentially hostile `.docx` parse and the Article create happen later in the sandboxed worker
 * child (SEC-002). The web client polls {@link getStatus}. PostgreSQL is the system of record; the
 * queue is only transport, so the polling state is read straight from BullMQ.
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
   * bytes ride along base64-encoded — already ≤ MAX_IMPORT_SIZE_MB; the dangerous expansion happens
   * in the child.
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
    if (file.size > maxImportBytes()) {
      throw new BadRequestException(
        `File exceeds the ${maxImportMb()} MB import limit`,
      );
    }
    const ext = extensionOf(file.originalname);
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `Unsupported file type "${ext ? '.' + ext : '(none)'}". Supported: ${SUPPORTED_EXTENSIONS.map(
          (e) => '.' + e,
        ).join(', ')}.`,
      );
    }
    // Fail fast on a bad category — the worker would otherwise fail the job on the FK.
    await this.assertCategoryUsable(fields.categoryId);

    const data: ImportJobData = {
      originalname: file.originalname,
      contentBase64: file.buffer.toString('base64'),
      categoryId: fields.categoryId,
      status: fields.status,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.slug !== undefined ? { slug: fields.slug } : {}),
      authorId,
    };

    const job = await this.queue.add(ARTICLE_IMPORT_JOB_NAME, data, {
      // A parse / bomb failure is PERMANENT — retrying would just kill another child (SEC-002).
      attempts: 1,
      // Keep finished jobs pollable for a while, but bound the set (the queue is transport, not the
      // system of record). Failures linger longer so the user can read the outcome.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
    if (!job.id) {
      // Should never happen (BullMQ always assigns an id); fail loudly rather than return a bad handle.
      throw new Error('Failed to enqueue import job (no job id assigned)');
    }
    return { jobId: job.id };
  }

  /**
   * Poll an import job. 404 for an unknown id. `articleId` is set only once completed; `error` is a
   * short, PERMANENT-failure message only once failed (never "try again" — a parse/bomb failure
   * won't succeed on a retry).
   */
  async getStatus(jobId: string): Promise<ImportJobStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Import job ${jobId} not found`);
    }
    const state = this.mapState(await job.getState());
    const articleId =
      state === 'completed'
        ? ((job.returnvalue as ImportJobResult | undefined)?.articleId ?? null)
        : null;
    const error =
      state === 'failed' ? this.friendlyError(job.failedReason) : null;
    return { jobId, state, articleId, error };
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
    if (r.includes('no text content')) {
      return 'The file has no readable text content.';
    }
    if (r.includes('Unsupported file type')) {
      return 'That file type is not supported. Use a .md, .txt or .docx file.';
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
