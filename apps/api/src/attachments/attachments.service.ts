import { createReadStream, type ReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ARTICLE_IMAGE_MAX_MB,
  ARTICLE_IMAGE_MIME_TYPES,
  ASSET_ATTACHMENT_MAX_MB,
  ASSET_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_INLINE_MIME_TYPES,
  type AttachmentEntityType,
} from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ArticlesService } from '../articles/articles.service';
import { isServicePrincipal, type Principal } from '../auth/principal';
import {
  ATTACHMENT_REENCODE_JOB_NAME,
  ATTACHMENT_REENCODE_QUEUE,
  ATTACHMENTS_GC_GRACE_MS,
  maxTotalAttachmentBytes,
} from './attachments.constants';
import {
  blobPathFor,
  discardTmp,
  promoteBlob,
  readFileHead,
  sha256OfFile,
} from './attachment-storage';
import { sniffAttachment } from './magic-bytes';

/** The multer diskStorage file shape the upload handlers receive (path on the tmp dir, size, name). */
export interface UploadedAttachmentFile {
  path: string;
  size: number;
  originalname: string;
}

/** What the content endpoints stream: the blob + the stored (server-derived) serving metadata. */
export interface AttachmentContent {
  stream: ReadStream;
  mimeType: string;
  byteSize: number;
  originalName: string;
}

/** Per-surface caps + allowlists (ADR-0082 §3). */
const SURFACE = {
  ASSET: {
    maxBytes: ASSET_ATTACHMENT_MAX_MB * 1024 * 1024,
    maxMb: ASSET_ATTACHMENT_MAX_MB,
    mimeTypes: ASSET_ATTACHMENT_MIME_TYPES as readonly string[],
  },
  ARTICLE: {
    maxBytes: ARTICLE_IMAGE_MAX_MB * 1024 * 1024,
    maxMb: ARTICLE_IMAGE_MAX_MB,
    mimeTypes: ARTICLE_IMAGE_MIME_TYPES as readonly string[],
  },
} as const;

/**
 * File attachments (ADR-0082): asset documents + KB inline images over ONE polymorphic model. This
 * service owns the whole lifecycle — upload (authz → caps/budget → magic-byte sniff → blob-first
 * write), per-parent list, hardened serving, soft delete — while the module's sandboxed processor
 * re-encodes raster images and the daily GC sweep reclaims orphans.
 *
 * AuthZ is ALWAYS the PARENT's rule, resolved live per call:
 * - ASSET: the route guard enforces `asset:read` / `asset:write`; the parent must be live (404).
 * - ARTICLE: reads go through {@link ArticlesService.findOne} (draft privacy ADR-0022 + folder ACL
 *   ADR-0060, both 404 — never an existence-leaking 403); writes through
 *   {@link ArticlesService.assertAttachmentWritable} (the edit gate).
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly articles: ArticlesService,
    @InjectQueue(ATTACHMENT_REENCODE_QUEUE)
    private readonly reencodeQueue: Queue,
  ) {}

  /**
   * Accept one uploaded file for a parent. The bytes are already on disk in `attachments/tmp/`
   * (multer diskStorage — never memory); EVERY exit path discards the tmp file (a successful
   * promote renames it away first, so the discard is a no-op there). Order:
   * authz → per-file cap → total budget → magic-byte sniff + allowlist → sha256 → atomic promote
   * (dedup by content) → row insert (blob-first, ADR-0082 §3) → best-effort raster re-encode enqueue.
   */
  async upload(
    entityType: AttachmentEntityType,
    entityId: string,
    file: UploadedAttachmentFile | undefined,
    principal?: Principal,
  ) {
    try {
      if (!file?.path) {
        throw new BadRequestException('A file is required');
      }
      const uploadedById = this.requireHuman(principal);
      await this.assertParentWritable(entityType, entityId, principal);

      const surface = SURFACE[entityType];
      // Defense in depth behind the interceptor's hard multer cap (which already aborts the stream).
      if (file.size > surface.maxBytes) {
        throw new PayloadTooLargeException(
          `File exceeds the ${surface.maxMb} MB attachment limit`,
        );
      }
      await this.assertWithinBudget(file.size);

      const sniff = sniffAttachment(
        await readFileHead(file.path),
        file.originalname,
      );
      if (!sniff.ok) {
        throw new UnsupportedMediaTypeException(sniff.reason);
      }
      if (!surface.mimeTypes.includes(sniff.mimeType)) {
        throw new UnsupportedMediaTypeException(
          `${sniff.mimeType} is not an accepted type here. Accepted: ${surface.mimeTypes.join(', ')}.`,
        );
      }

      const sha256 = await sha256OfFile(file.path);
      await promoteBlob(file.path, sha256);
      const row = await this.prisma.attachment.create({
        data: {
          entityType,
          entityId,
          sha256,
          byteSize: file.size,
          mimeType: sniff.mimeType,
          originalName: file.originalname,
          uploadedById,
        },
      });
      if (
        (ATTACHMENT_INLINE_MIME_TYPES as readonly string[]).includes(
          sniff.mimeType,
        )
      ) {
        await this.enqueueReencode(row.id);
      }
      return row;
    } finally {
      await discardTmp(file?.path);
    }
  }

  /** Live attachments of one parent, newest first — behind the parent's READ authz. */
  async list(
    entityType: AttachmentEntityType,
    entityId: string,
    user?: User,
    principal?: Principal,
  ) {
    await this.assertParentReadable(entityType, entityId, user, principal);
    return this.prisma.attachment.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The blob of one attachment, for streaming — behind the parent's READ authz. 404 (never 403) for
   * a missing / soft-deleted / wrong-parent attachment, and for a vanished blob (the documented DR
   * gap: rows can outlive bytes after a host loss — degrade to a clear 404, never a crash).
   */
  async getContent(
    entityType: AttachmentEntityType,
    entityId: string,
    attachmentId: string,
    user?: User,
    principal?: Principal,
  ): Promise<AttachmentContent> {
    await this.assertParentReadable(entityType, entityId, user, principal);
    const row = await this.findRow(entityType, entityId, attachmentId);
    const path = blobPathFor(row.sha256);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.logger.warn(
        `Attachment ${row.id} points at a missing blob ${row.sha256} (backup gap? see ADR-0082)`,
      );
      throw new NotFoundException(
        `Attachment ${attachmentId} content is unavailable`,
      );
    }
    return {
      stream: createReadStream(path),
      mimeType: row.mimeType,
      byteSize: size,
      originalName: row.originalName,
    };
  }

  /**
   * Soft-delete an attachment — behind the parent's WRITE authz (ADR-0006: never a hard delete; the
   * blob stays until the GC proves nothing restorable references it — ADR-0082 §6). HUMAN-only for
   * BOTH parents, symmetric with upload: the ARTICLE edit gate already rejects a service account,
   * and the explicit gate here keeps an `asset:write` SA from deleting asset documents too.
   */
  async remove(
    entityType: AttachmentEntityType,
    entityId: string,
    attachmentId: string,
    principal?: Principal,
  ) {
    this.requireHuman(principal);
    await this.assertParentWritable(entityType, entityId, principal);
    const row = await this.findRow(entityType, entityId, attachmentId);
    return this.prisma.attachment.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
  }

  /** A live attachment row scoped to ITS parent (id alone never resolves across parents) — else 404. */
  private async findRow(
    entityType: AttachmentEntityType,
    entityId: string,
    attachmentId: string,
  ) {
    const row = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, entityType, entityId },
    });
    if (!row) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    return row;
  }

  /**
   * READ authz, per parent. ASSET: live row or 404 (the route guard already checked `asset:read`).
   * ARTICLE: the full visibility gate — draft privacy + folder ACL, both 404 (ADR-0022/0060).
   */
  private async assertParentReadable(
    entityType: AttachmentEntityType,
    entityId: string,
    user?: User,
    principal?: Principal,
  ): Promise<void> {
    if (entityType === 'ASSET') {
      await this.assertAssetLive(entityId);
      return;
    }
    await this.articles.findOne(entityId, user, principal);
  }

  /**
   * WRITE authz, per parent. ASSET: live row or 404 (the route guard already checked `asset:write`
   * — assets have no per-row ownership). ARTICLE: the edit gate (author / ADMIN / `article:manage`,
   * folder ACL included).
   */
  private async assertParentWritable(
    entityType: AttachmentEntityType,
    entityId: string,
    principal?: Principal,
  ): Promise<void> {
    if (entityType === 'ASSET') {
      await this.assertAssetLive(entityId);
      return;
    }
    await this.articles.assertAttachmentWritable(entityId, principal);
  }

  /** 404 unless the asset exists and is live (the soft-delete read filter hides deleted rows). */
  private async assertAssetLive(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }
  }

  /**
   * Attachment WRITES (upload + delete) are HUMAN-only (`Attachment.uploadedById` is a User FK — a
   * service account has no User identity to attribute the action to; honest 403, mirroring article
   * authorship). Returns the human's id (the upload's `uploadedById`).
   */
  private requireHuman(principal?: Principal): string {
    if (isServicePrincipal(principal)) {
      throw new ForbiddenException(
        'Service accounts cannot manage attachments (attachment writes are human-only)',
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

  /**
   * The single-host storage quota (ADR-0082 §7): bytes NOT YET PHYSICALLY RECLAIMED + the incoming
   * file must fit `ATTACHMENTS_MAX_TOTAL_MB`. Over budget → a clean, UI-mappable **507 "storage
   * full"** — never a 500 or a half-written blob (the tmp file is discarded by the caller's finally).
   *
   * "Not yet reclaimed" = live rows PLUS rows soft-deleted within the GC grace window (their blobs
   * are still on disk until the daily sweep runs — counting only live rows let upload→delete→upload
   * churn stack many × the budget on disk inside that window, defeating the "one thing can't sink
   * the host" invariant). Soft-deleted rows past the grace drop out of the sum — their blobs are
   * gone (or about to be) and version-pinned survivors are the rare, accepted slack. Summed
   * DISTINCT-by-sha256 (`groupBy`), so dedup-shared blobs count once — matching real disk use.
   */
  private async assertWithinBudget(nextBytes: number): Promise<void> {
    const max = maxTotalAttachmentBytes();
    const graceCutoff = new Date(Date.now() - ATTACHMENTS_GC_GRACE_MS);
    // includeSoftDeleted (spread past groupBy's strict arg type — the extension strips it): the
    // soft-delete extension would otherwise scope this aggregate to live rows — exactly the churn
    // hole this closes; the where clause re-bounds the read to the not-yet-reclaimed window.
    const blobs = await this.prisma.attachment.groupBy({
      by: ['sha256'],
      where: {
        OR: [{ deletedAt: null }, { deletedAt: { gt: graceCutoff } }],
      },
      _max: { byteSize: true },
      orderBy: { sha256: 'asc' },
      ...({ includeSoftDeleted: true } as object),
    });
    const used = blobs.reduce((sum, b) => sum + (b._max.byteSize ?? 0), 0);
    if (used + nextBytes > max) {
      throw new HttpException(
        `Attachment storage is full (the ${Math.floor(max / (1024 * 1024))} MB total limit would be exceeded). Ask your administrator to free space or raise ATTACHMENTS_MAX_TOTAL_MB.`,
        HttpStatus.INSUFFICIENT_STORAGE,
      );
    }
  }

  /**
   * Enqueue the sandboxed raster re-encode (EXIF/GPS strip + polyglot neutralization, ADR-0082 §3).
   * BEST-EFFORT: serving is already hardened (nosniff + CSP sandbox + inline only for rasters), so a
   * down broker degrades to keep-original + a warning — never a failed upload.
   */
  private async enqueueReencode(attachmentId: string): Promise<void> {
    try {
      await this.reencodeQueue.add(
        ATTACHMENT_REENCODE_JOB_NAME,
        { attachmentId },
        {
          attempts: 1,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600, count: 1000 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not enqueue re-encode for attachment ${attachmentId} (keeping the original): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
