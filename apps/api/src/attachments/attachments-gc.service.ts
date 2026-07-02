import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ATTACHMENT_REF_PREFIX } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTACHMENTS_GC_EVERY_MS,
  ATTACHMENTS_GC_GRACE_MS,
  ATTACHMENTS_GC_JOB_NAME,
  ATTACHMENTS_GC_QUEUE,
  ATTACHMENTS_GC_SCHEDULER_ID,
  attachmentsDir,
} from './attachments.constants';
import { attachmentsTmpDir, blobPathFor } from './attachment-storage';

export interface GcSweepResult {
  /** Never-referenced ARTICLE images soft-deleted past the 24 h grace (pin 4, first pass). */
  orphanedRows: number;
  /** Blobs physically unlinked (pins 2+3: nothing live and nothing restorable references them). */
  blobsUnlinked: number;
  /** Crash leftovers reclaimed: stale tmp files + promoted blobs that never got a row (§3). */
  staleFilesRemoved: number;
}

/**
 * The attachments GC (ADR-0082 §6) — the four-pin contract that reconciles "never hard-delete"
 * (ADR-0006) with a finite single-host disk:
 *
 *  1. Parent soft-delete never purges blobs (nothing here reacts to a parent delete at all — the
 *     rows stay live and pin their blobs; the parent's 404 already hides them, and a parent restore
 *     brings them straight back).
 *  2. The REFERENCE SET pinning a row is the union of: live article bodies + soft-deleted article
 *     bodies + ALL `ArticleVersion` snapshots. Versions are append-only ⇒ an image ever saved in
 *     any version is pinned forever — a version restore can never surface a broken image (red line).
 *  3. A blob is physically unlinked only when NO live row references its sha256 (dedup-safe) AND no
 *     row of that sha is pinned by the reference set.
 *  4. The DAILY BullMQ sweep (the worker below drives {@link sweep}) first soft-deletes
 *     never-referenced ARTICLE-image orphans past a 24 h grace (images pasted into an abandoned
 *     draft), then unlinks unpinned blobs. The audit row (who/when) survives the bytes.
 *
 * ASSET attachments have no body to reference them: they are pinned by their own live row, and an
 * explicit user delete releases the blob to pass 2 (nothing restorable points at it — the metadata
 * row survives as the audit trail, per pin 4).
 *
 * Scheduling: a BullMQ repeatable job (upsertJobScheduler — idempotent across re-deploys), per the
 * ADR's "daily BullMQ sweep". A down broker degrades to a boot warning, never a boot failure.
 */
@Injectable()
export class AttachmentsGcService implements OnModuleInit {
  private readonly logger = new Logger(AttachmentsGcService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ATTACHMENTS_GC_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        ATTACHMENTS_GC_SCHEDULER_ID,
        { every: ATTACHMENTS_GC_EVERY_MS },
        {
          name: ATTACHMENTS_GC_JOB_NAME,
          opts: {
            removeOnComplete: { count: 10 },
            removeOnFail: { count: 10 },
          },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not schedule the attachments GC sweep (queue unreachable?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * One full sweep. Every pass is independent and failure-isolated by the worker's catch — a
   * missing directory (no upload ever happened) is simply zero work.
   */
  async sweep(now = new Date()): Promise<GcSweepResult> {
    const cutoff = new Date(now.getTime() - ATTACHMENTS_GC_GRACE_MS);
    const orphanedRows = await this.orphanArticleImages(cutoff, now);
    const blobsUnlinked = await this.unlinkUnpinnedBlobs(cutoff);
    const staleFilesRemoved = await this.removeCrashLeftovers(cutoff);
    if (orphanedRows || blobsUnlinked || staleFilesRemoved) {
      this.logger.log(
        `Attachments GC: ${orphanedRows} orphan row(s) soft-deleted, ${blobsUnlinked} blob(s) unlinked, ${staleFilesRemoved} stale file(s) removed.`,
      );
    }
    return { orphanedRows, blobsUnlinked, staleFilesRemoved };
  }

  /**
   * Pass 1 (pin 4): soft-delete live ARTICLE-image rows older than the grace window that NO article
   * body (live or soft-deleted) and NO ArticleVersion snapshot references. Asset attachments are
   * exempt — they have no body reference; their live row IS the reference.
   */
  private async orphanArticleImages(cutoff: Date, now: Date): Promise<number> {
    const candidates = await this.prisma.attachment.findMany({
      where: { entityType: 'ARTICLE', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 1000,
    });
    let orphaned = 0;
    for (const candidate of candidates) {
      if (await this.isPinned(candidate.id)) continue;
      await this.prisma.attachment.update({
        where: { id: candidate.id },
        data: { deletedAt: now },
      });
      orphaned += 1;
    }
    return orphaned;
  }

  /**
   * Pass 2 (pins 2+3): physically unlink a blob only when EVERY row of its sha256 has been
   * soft-deleted for longer than the grace AND none of those rows is pinned by the reference set
   * (bodies incl. soft-deleted + all version snapshots). One live row anywhere — dedup included —
   * keeps the blob.
   */
  private async unlinkUnpinnedBlobs(cutoff: Date): Promise<number> {
    const deadRows = (await this.prisma.attachment.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true, sha256: true, deletedAt: true },
      includeSoftDeleted: true,
    } as Prisma.AttachmentFindManyArgs)) as Array<{
      id: string;
      sha256: string;
      deletedAt: Date | null;
    }>;
    const bySha = new Map<string, typeof deadRows>();
    for (const row of deadRows) {
      const group = bySha.get(row.sha256) ?? [];
      group.push(row);
      bySha.set(row.sha256, group);
    }
    let unlinked = 0;
    for (const [sha256, rows] of bySha) {
      // Grace: a just-deleted row keeps its blob for one window (cheap undo margin + upload races).
      if (rows.some((r) => r.deletedAt && r.deletedAt > cutoff)) continue;
      // Pin 3: any LIVE row of this sha (dedup!) keeps the blob.
      const liveCount = await this.prisma.attachment.count({
        where: { sha256 },
      });
      if (liveCount > 0) continue;
      // Pin 2: any of this blob's rows referenced by a body/version keeps the blob (version restore).
      let pinned = false;
      for (const row of rows) {
        if (await this.isPinned(row.id)) {
          pinned = true;
          break;
        }
      }
      if (pinned) continue;
      const removed = await this.rmIfExists(blobPathFor(sha256));
      if (removed) unlinked += 1;
    }
    return unlinked;
  }

  /**
   * Pass 3 (ADR-0082 §3 crash recovery): reclaim files the two-step write can leave behind — stale
   * `tmp/` uploads, and PROMOTED blobs whose row insert never happened. Both only past the grace
   * (mtime), so an in-flight upload is never yanked.
   */
  private async removeCrashLeftovers(cutoff: Date): Promise<number> {
    let removed = 0;
    // Stale tmp files.
    const tmpDir = attachmentsTmpDir();
    for (const name of await this.readdirSafe(tmpDir)) {
      const path = join(tmpDir, name);
      if (await this.isOlderThan(path, cutoff)) {
        if (await this.rmIfExists(path)) removed += 1;
      }
    }
    // Row-less blobs in the shard dirs.
    const root = attachmentsDir();
    for (const shard of await this.readdirSafe(root)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      const names = (await this.readdirSafe(join(root, shard))).filter((n) =>
        /^[0-9a-f]{64}$/.test(n),
      );
      if (names.length === 0) continue;
      const known = (await this.prisma.attachment.findMany({
        where: { sha256: { in: names } },
        select: { sha256: true },
        includeSoftDeleted: true,
      } as Prisma.AttachmentFindManyArgs)) as Array<{ sha256: string }>;
      const knownSet = new Set(known.map((k) => k.sha256));
      for (const name of names) {
        if (knownSet.has(name)) continue;
        const path = join(root, shard, name);
        if (await this.isOlderThan(path, cutoff)) {
          if (await this.rmIfExists(path)) removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * Is this attachment id referenced anywhere restorable (pin 2)? `attachment:<id>` in any article
   * body — INCLUDING soft-deleted articles (their restore must keep images) — or in any append-only
   * ArticleVersion snapshot (a version restore must never show a broken image).
   */
  private async isPinned(attachmentId: string): Promise<boolean> {
    const needle = `${ATTACHMENT_REF_PREFIX}${attachmentId}`;
    const inBody = await this.prisma.article.count({
      where: { content: { contains: needle } },
      includeSoftDeleted: true,
    } as Prisma.ArticleCountArgs);
    if (inBody > 0) return true;
    const inVersion = await this.prisma.articleVersion.count({
      where: { content: { contains: needle } },
    });
    return inVersion > 0;
  }

  private async readdirSafe(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  private async isOlderThan(path: string, cutoff: Date): Promise<boolean> {
    try {
      return (await stat(path)).mtime < cutoff;
    } catch {
      return false;
    }
  }

  private async rmIfExists(path: string): Promise<boolean> {
    try {
      await rm(path);
      return true;
    } catch {
      return false;
    }
  }
}
