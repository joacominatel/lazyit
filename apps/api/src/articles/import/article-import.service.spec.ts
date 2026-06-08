import { ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ImportArticle } from '@lazyit/shared';
import { ArticleImportService } from './article-import.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Principal } from '../../auth/principal';
import type { UploadedImportFile } from './import-job.types';

// Stub the generated Prisma client so the test never loads the real one (no DB / no native engine).
// ArticleImportService → PrismaService → ../../generated/prisma/client; this short-circuits that load
// (jest hoists the mock above the imports — matches the pattern in articles.service.spec.ts).
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Unit tests for the enqueue 503 path and stalled-job surfacing (issue #257). The heavy parse is
 * covered by create-imported-article.spec.ts / docx-bomb.spec.ts; here we only assert how the
 * service reacts when the BullMQ/Valkey broker is unreachable.
 */

const HUMAN: Principal = {
  kind: 'human',
  user: { id: '11111111-1111-1111-1111-111111111111' },
} as unknown as Principal;

const FIELDS: ImportArticle = {
  categoryId: 'cat1',
  status: 'DRAFT',
} as unknown as ImportArticle;

function mdFile(): UploadedImportFile {
  return {
    originalname: 'note.md',
    buffer: Buffer.from('# Hello\n\nWorld'),
    size: 13,
  };
}

function makeService(queueAdd: jest.Mock, getJob?: jest.Mock) {
  const queue = {
    add: queueAdd,
    getJob: getJob ?? jest.fn(),
  } as unknown as Queue;
  const prisma = {
    articleCategory: {
      // assertCategoryUsable → a live category exists.
      findFirst: jest.fn().mockResolvedValue({ id: 'cat1' }),
    },
  } as unknown as PrismaService;
  return new ArticleImportService(queue, prisma);
}

describe('ArticleImportService.enqueue — broker reachability (issue #257)', () => {
  it('returns the jobId on a normal enqueue', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job-123' });
    const service = makeService(add);
    await expect(service.enqueue(mdFile(), FIELDS, HUMAN)).resolves.toEqual({
      jobId: 'job-123',
    });
  });

  it('translates an offline-queue rejection into a 503 (not a hung 202)', async () => {
    const add = jest
      .fn()
      .mockRejectedValue(
        new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        ),
      );
    const service = makeService(add);
    await expect(
      service.enqueue(mdFile(), FIELDS, HUMAN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('translates a raw ECONNREFUSED into a 503', async () => {
    const add = jest.fn().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
        code: 'ECONNREFUSED',
      }),
    );
    const service = makeService(add);
    await expect(
      service.enqueue(mdFile(), FIELDS, HUMAN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does NOT mask an unrelated enqueue error as 503 (re-throws it)', async () => {
    const add = jest.fn().mockRejectedValue(new Error('some programmer bug'));
    const service = makeService(add);
    await expect(service.enqueue(mdFile(), FIELDS, HUMAN)).rejects.toThrow(
      'some programmer bug',
    );
  });

  it('never logs the raw connection error message to the client (friendly 503 only)', async () => {
    const add = jest.fn().mockRejectedValue(new Error('Connection is closed.'));
    const service = makeService(add);
    await expect(service.enqueue(mdFile(), FIELDS, HUMAN)).rejects.toThrow(
      /temporarily unavailable/i,
    );
  });
});

describe('ArticleImportService.getStatus — stalled job surfacing (issue #257)', () => {
  it('maps a stalled failure to a friendly, retryable message', async () => {
    const getJob = jest.fn().mockResolvedValue({
      getState: jest.fn().mockResolvedValue('failed'),
      failedReason: 'job stalled more than allowable limit',
      returnvalue: undefined,
    });
    const service = makeService(jest.fn(), getJob);
    const status = await service.getStatus('job-1');
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/timed out/i);
    expect(status.error).not.toContain('stalled'); // never echo the raw reason
  });
});
