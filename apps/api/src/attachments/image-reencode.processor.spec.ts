import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxedJob } from 'bullmq';
import { blobPathFor } from './attachment-storage';

const MOCK_REENCODED = Buffer.from('re-encoded pixels');
const ORIGINAL = Buffer.from('original png bytes');
const OLD_SHA = createHash('sha256').update(ORIGINAL).digest('hex');
const NEW_SHA = createHash('sha256').update(MOCK_REENCODED).digest('hex');
const ROW_ID = 'clatt0000000000000000000';

type Row = { id: string; sha256: string; mimeType: string };

/** The fake DB: committed rows, locks this job holds, and locks other transactions hold. */
const db: { rows: Row[]; held: Set<string>; lockedElsewhere: Set<string> } = {
  rows: [],
  held: new Set(),
  lockedElsewhere: new Set(),
};
let onUpdate: (() => Promise<void>) | undefined;

const mockPrisma = {
  attachment: {
    findFirst: jest.fn((args: { where: { id: string } }) => {
      const row = db.rows.find((r) => r.id === args.where.id);
      return row && { ...row };
    }),
    update: jest.fn(
      async (args: { where: { id: string }; data: { sha256: string } }) => {
        await onUpdate?.();
        const row = db.rows.find((r) => r.id === args.where.id)!;
        row.sha256 = args.data.sha256;
        return row;
      },
    ),
    count: jest.fn(
      (args: { where: { sha256: string } }) =>
        db.rows.filter((r) => r.sha256 === args.where.sha256).length,
    ),
  },
  $executeRaw: jest.fn((_sql: unknown, _ns: string, sha: string) => {
    db.held.add(sha);
    return 1;
  }),
  $queryRaw: jest.fn((_sql: unknown, _ns: string, sha: string) => [
    { locked: !db.lockedElsewhere.has(sha) },
  ]),
  $transaction: jest.fn(
    async (cb: (tx: unknown) => unknown): Promise<unknown> => {
      const before = new Set(db.held);
      try {
        return await cb(mockPrisma);
      } finally {
        for (const sha of db.held) if (!before.has(sha)) db.held.delete(sha);
      }
    },
  ),
};

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      return mockPrisma;
    }
  },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('./attachment-reencode', () => ({
  RASTER_FORMATS: { 'image/png': 'png' },
  reencodeRaster: () => ({
    toFile: (path: string) =>
      jest
        .requireActual<typeof import('node:fs/promises')>('node:fs/promises')
        .writeFile(path, MOCK_REENCODED),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import processor = require('./image-reencode.processor');

const job = { data: { attachmentId: ROW_ID } } as SandboxedJob<{
  attachmentId: string;
}>;

describe('image re-encode processor — blob reclaim (ADR-0082 §3, AUD-021)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazyit-reencode-'));
    process.env.ATTACHMENTS_DIR = root;
    process.env.DATABASE_URL = 'postgres://unused';
    db.rows = [{ id: ROW_ID, sha256: OLD_SHA, mimeType: 'image/png' }];
    db.held.clear();
    db.lockedElsewhere.clear();
    onUpdate = undefined;
    await mkdir(join(root, OLD_SHA.slice(0, 2)), { recursive: true });
    await writeFile(blobPathFor(OLD_SHA, root), ORIGINAL);
  });

  afterEach(() => {
    delete process.env.ATTACHMENTS_DIR;
  });

  it('replaces the blob and reclaims the pre-encode one nothing references', async () => {
    await expect(processor(job)).resolves.toEqual({ ok: true });
    expect(db.rows[0].sha256).toBe(NEW_SHA);
    expect(existsSync(blobPathFor(NEW_SHA, root))).toBe(true);
    expect(existsSync(blobPathFor(OLD_SHA, root))).toBe(false);
  });

  it('keeps the pre-encode blob while an upload deduping onto it holds its lock', async () => {
    // Same bytes uploaded again: its promote deduped onto OLD_SHA, its row is not committed yet.
    db.lockedElsewhere.add(OLD_SHA);
    await expect(processor(job)).resolves.toEqual({ ok: true });
    expect(existsSync(blobPathFor(OLD_SHA, root))).toBe(true);
  });

  it('holds the new blob lock until its row points at it', async () => {
    // A concurrent reclaimer sees no row on NEW_SHA yet and unlinks it unless the lock is held.
    onUpdate = async () => {
      if (!db.held.has(NEW_SHA)) {
        await rm(blobPathFor(NEW_SHA, root), { force: true });
      }
    };
    await expect(processor(job)).resolves.toEqual({ ok: true });
    expect(existsSync(blobPathFor(NEW_SHA, root))).toBe(true);
  });
});
