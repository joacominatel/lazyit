import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentsGcService } from './attachments-gc.service';
import { blobPathFor } from './attachment-storage';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

const NOW = new Date('2026-07-01T12:00:00Z');
const OLD = new Date('2026-06-20T12:00:00Z'); // far past the 24 h grace
const FRESH = new Date('2026-07-01T11:00:00Z'); // inside the grace

const ORPHAN_ID = 'clorphan0000000000000000';
const PINNED_ID = 'clpinned0000000000000000';
const ORPHAN_SHA = 'aa' + '1'.repeat(62);
const PINNED_SHA = 'bb' + '2'.repeat(62);
const SHARED_SHA = 'cc' + '3'.repeat(62);

type Row = {
  id: string;
  sha256: string;
  entityType: string;
  createdAt: Date;
  deletedAt: Date | null;
};

describe('AttachmentsGcService — the four-pin contract (ADR-0082 §6)', () => {
  let root: string;
  let rows: Row[];
  /** Article/version bodies the mock "contains" queries scan — the pin-2 reference set. */
  let articleBodies: string[];
  let versionBodies: string[];
  let prisma: {
    attachment: { findMany: jest.Mock; count: jest.Mock; update: jest.Mock };
    article: { count: jest.Mock };
    articleVersion: { count: jest.Mock };
  };
  let service: AttachmentsGcService;

  async function writeBlob(sha: string, mtime = OLD): Promise<string> {
    const path = blobPathFor(sha, root);
    await mkdir(join(root, sha.slice(0, 2)), { recursive: true });
    await writeFile(path, `blob-${sha}`);
    await utimes(path, mtime, mtime);
    return path;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazyit-attachments-gc-'));
    process.env.ATTACHMENTS_DIR = root;
    rows = [];
    articleBodies = [];
    versionBodies = [];
    prisma = {
      attachment: {
        // Dispatch on the where-shape: pass 1 (live ARTICLE candidates), pass 2 (soft-deleted rows),
        // pass 3 (sha256 IN [...] existence probe). Mirrors what the soft-delete extension + the
        // includeSoftDeleted escape hatch resolve to against a real DB.
        findMany: jest.fn(
          (args: {
            where: {
              entityType?: string;
              createdAt?: { lt: Date };
              deletedAt?: { not: null };
              sha256?: { in: string[] };
            };
          }) => {
            const w = args.where;
            if (w.sha256?.in) {
              return rows.filter((r) => w.sha256!.in.includes(r.sha256));
            }
            if (w.deletedAt) {
              return rows.filter((r) => r.deletedAt !== null);
            }
            return rows.filter(
              (r) =>
                r.deletedAt === null &&
                r.entityType === w.entityType &&
                r.createdAt < w.createdAt!.lt,
            );
          },
        ),
        // Live-row count per sha (pin 3) — the extension would inject deletedAt: null.
        count: jest.fn(
          (args: { where: { sha256: string } }) =>
            rows.filter(
              (r) => r.sha256 === args.where.sha256 && r.deletedAt === null,
            ).length,
        ),
        update: jest.fn(
          (args: { where: { id: string }; data: { deletedAt: Date } }) => {
            const row = rows.find((r) => r.id === args.where.id);
            if (row) row.deletedAt = args.data.deletedAt;
            return row;
          },
        ),
      },
      article: {
        count: jest.fn(
          (args: { where: { content: { contains: string } } }) =>
            articleBodies.filter((b) => b.includes(args.where.content.contains))
              .length,
        ),
      },
      articleVersion: {
        count: jest.fn(
          (args: { where: { content: { contains: string } } }) =>
            versionBodies.filter((b) => b.includes(args.where.content.contains))
              .length,
        ),
      },
    };
    service = new AttachmentsGcService(
      prisma as never,
      {
        upsertJobScheduler: jest.fn(),
      } as never,
    );
  });

  afterEach(() => {
    delete process.env.ATTACHMENTS_DIR;
  });

  it('pass 1: a version-referenced image is NEVER orphaned (pin 2 — version restore stays whole)', async () => {
    rows.push({
      id: PINNED_ID,
      sha256: PINNED_SHA,
      entityType: 'ARTICLE',
      createdAt: OLD,
      deletedAt: null,
    });
    // Referenced ONLY by an old ArticleVersion snapshot — not by any live body.
    versionBodies.push(`intro ![old](attachment:${PINNED_ID}) outro`);
    await writeBlob(PINNED_SHA);

    const result = await service.sweep(NOW);
    expect(result.orphanedRows).toBe(0);
    expect(prisma.attachment.update).not.toHaveBeenCalled();
    expect(existsSync(blobPathFor(PINNED_SHA, root))).toBe(true);
  });

  it('pass 1+2: a never-referenced draft-paste past the grace is soft-deleted AND its blob reclaimed', async () => {
    rows.push({
      id: ORPHAN_ID,
      sha256: ORPHAN_SHA,
      entityType: 'ARTICLE',
      createdAt: OLD,
      // Pre-aged soft-delete so THIS sweep's pass 2 sees it past the grace (a live orphan takes two
      // daily runs against a real clock: soft-delete today, unlink after tomorrow's grace).
      deletedAt: OLD,
    });
    await writeBlob(ORPHAN_SHA);

    const result = await service.sweep(NOW);
    expect(result.blobsUnlinked).toBe(1);
    expect(existsSync(blobPathFor(ORPHAN_SHA, root))).toBe(false);
  });

  it('pass 1: a fresh never-referenced image is left alone (inside the 24 h grace)', async () => {
    rows.push({
      id: ORPHAN_ID,
      sha256: ORPHAN_SHA,
      entityType: 'ARTICLE',
      createdAt: FRESH,
      deletedAt: null,
    });
    const result = await service.sweep(NOW);
    expect(result.orphanedRows).toBe(0);
  });

  it('pass 1: an unreferenced ARTICLE image past the grace gets soft-deleted (row survives as audit)', async () => {
    rows.push({
      id: ORPHAN_ID,
      sha256: ORPHAN_SHA,
      entityType: 'ARTICLE',
      createdAt: OLD,
      deletedAt: null,
    });
    const result = await service.sweep(NOW);
    expect(result.orphanedRows).toBe(1);
    expect(rows[0].deletedAt).toEqual(NOW);
  });

  it('pass 1: ASSET documents are exempt from orphaning (their live row IS the reference)', async () => {
    rows.push({
      id: ORPHAN_ID,
      sha256: ORPHAN_SHA,
      entityType: 'ASSET',
      createdAt: OLD,
      deletedAt: null,
    });
    const result = await service.sweep(NOW);
    expect(result.orphanedRows).toBe(0);
  });

  it('pass 2: a dedup-shared blob survives while ANY live row still references its sha (pin 3)', async () => {
    rows.push(
      {
        id: 'cldead000000000000000000',
        sha256: SHARED_SHA,
        entityType: 'ASSET',
        createdAt: OLD,
        deletedAt: OLD,
      },
      {
        id: 'cllive000000000000000000',
        sha256: SHARED_SHA,
        entityType: 'ASSET',
        createdAt: OLD,
        deletedAt: null,
      },
    );
    await writeBlob(SHARED_SHA);
    const result = await service.sweep(NOW);
    expect(result.blobsUnlinked).toBe(0);
    expect(existsSync(blobPathFor(SHARED_SHA, root))).toBe(true);
  });

  it('pass 2: a soft-deleted row pinned by a version snapshot keeps its blob (red line)', async () => {
    rows.push({
      id: PINNED_ID,
      sha256: PINNED_SHA,
      entityType: 'ARTICLE',
      createdAt: OLD,
      deletedAt: OLD,
    });
    versionBodies.push(`![kept](attachment:${PINNED_ID})`);
    await writeBlob(PINNED_SHA);
    const result = await service.sweep(NOW);
    expect(result.blobsUnlinked).toBe(0);
    expect(existsSync(blobPathFor(PINNED_SHA, root))).toBe(true);
  });

  it('pass 2: a SOFT-DELETED article body still pins its images (pin 2 — the parent restore path)', async () => {
    rows.push({
      id: PINNED_ID,
      sha256: PINNED_SHA,
      entityType: 'ARTICLE',
      createdAt: OLD,
      deletedAt: OLD,
    });
    // The (soft-deleted) article body is scanned via includeSoftDeleted — the mock keeps it visible.
    articleBodies.push(`body with ![img](attachment:${PINNED_ID})`);
    await writeBlob(PINNED_SHA);
    const result = await service.sweep(NOW);
    expect(result.blobsUnlinked).toBe(0);
    expect(existsSync(blobPathFor(PINNED_SHA, root))).toBe(true);
  });

  it('pass 3: crash leftovers — a stale tmp file and a row-less promoted blob are reclaimed past the grace', async () => {
    const tmpDir = join(root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const staleTmp = join(tmpDir, 'upload-stale');
    await writeFile(staleTmp, 'x');
    await utimes(staleTmp, OLD, OLD);
    const freshTmp = join(tmpDir, 'upload-fresh');
    await writeFile(freshTmp, 'x');
    // A promoted blob whose row insert never happened (crash between rename and insert):
    const rowless = await writeBlob('dd' + '4'.repeat(62));

    const result = await service.sweep(NOW);
    expect(result.staleFilesRemoved).toBe(2);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true); // in-flight upload untouched
    expect(existsSync(rowless)).toBe(false);
  });
});
