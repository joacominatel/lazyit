import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ImportSessionService } from './import-session.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { UploadedImportFile } from './import-job.types';

// Stub the generated Prisma client so the test never loads the real one (no DB / no native engine).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Unit tests for the ImportSession service (ADR-0069 wave 2, #629): create-and-parse enqueues the
 * sandboxed job + hashes the file, the broker-down path 503s and marks the session FAILED, and the
 * owner-scoped read 404s for a session that isn't the caller's (no IDOR).
 */

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const file: UploadedImportFile = {
  originalname: 'assets.csv',
  buffer: Buffer.from('name,serial\nLaptop,A1\n', 'utf-8'),
  size: 23,
};

describe('ImportSessionService.createAndParse', () => {
  it('creates a PENDING session (hashing the file) and enqueues the parse job', async () => {
    const created: unknown[] = [];
    const added: { name: string; data: unknown; opts: unknown }[] = [];
    const prisma = {
      importSession: {
        create: async (args: { data: unknown }) => {
          created.push(args.data);
          return { id: 'sess_1' };
        },
        update: async () => ({}),
      },
    } as unknown as PrismaService;
    const queue = {
      add: async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return { id: 'job_1' };
      },
    } as unknown as Queue;

    const service = new ImportSessionService(queue, prisma);
    const result = await service.createAndParse(OWNER, 'asset', 'csv', file);

    expect(result).toEqual({ sessionId: 'sess_1' });
    const data = created[0] as Record<string, unknown>;
    expect(data.entity).toBe('ASSET');
    expect(data.status).toBe('PENDING');
    expect(data.ownerId).toBe(OWNER);
    // The file hash is stored (never the contents).
    expect(typeof data.fileHash).toBe('string');
    expect((data.fileHash as string).length).toBe(64);
    expect(data.expiresAt).toBeInstanceOf(Date);
    // Job enqueued with the base64 bytes + format, attempts:1.
    expect(added).toHaveLength(1);
    const jobData = added[0].data as Record<string, unknown>;
    expect(jobData.sessionId).toBe('sess_1');
    expect(jobData.format).toBe('csv');
    expect((added[0].opts as { attempts: number }).attempts).toBe(1);
  });

  it('503s and marks the session FAILED when the broker is unreachable', async () => {
    const updates: { data: Record<string, unknown> }[] = [];
    const prisma = {
      importSession: {
        create: async () => ({ id: 'sess_1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args);
          return {};
        },
      },
    } as unknown as PrismaService;
    const econn = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const queue = {
      add: async () => {
        throw econn;
      },
    } as unknown as Queue;

    const service = new ImportSessionService(queue, prisma);
    await expect(
      service.createAndParse(OWNER, 'asset', 'csv', file),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(updates[0].data.status).toBe('FAILED');
  });
});

describe('ImportSessionService.getForOwner', () => {
  function serviceWithSessions(
    rows: { id: string; ownerId: string }[],
  ): ImportSessionService {
    const prisma = {
      importSession: {
        findFirst: async (args: {
          where: { id: string; ownerId: string };
        }) => {
          const found = rows.find(
            (r) =>
              r.id === args.where.id && r.ownerId === args.where.ownerId,
          );
          if (!found) return null;
          return {
            id: found.id,
            entity: 'ASSET',
            status: 'PARSED',
            detected: {
              headers: ['name', 'serial'],
              dialect: { delimiter: ',', hadBom: false },
              encoding: 'utf-8',
              rowCount: 1,
            },
            error: null,
            rows: [
              {
                rowIndex: 0,
                status: 'PENDING',
                raw: { name: 'Laptop', serial: 'A1' },
              },
            ],
          };
        },
      },
    } as unknown as PrismaService;
    return new ImportSessionService({} as unknown as Queue, prisma);
  }

  it('returns the session with rows + summary for its owner', async () => {
    const service = serviceWithSessions([{ id: 'sess_1', ownerId: OWNER }]);
    const result = await service.getForOwner('sess_1', OWNER);
    expect(result.entity).toBe('asset');
    expect(result.status).toBe('PARSED');
    expect(result.headers).toEqual(['name', 'serial']);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].raw).toEqual({ name: 'Laptop', serial: 'A1' });
  });

  it('404s for a session owned by someone else (no IDOR)', async () => {
    const service = serviceWithSessions([{ id: 'sess_1', ownerId: OWNER }]);
    await expect(service.getForOwner('sess_1', OTHER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for an unknown session', async () => {
    const service = serviceWithSessions([]);
    await expect(service.getForOwner('nope', OWNER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
