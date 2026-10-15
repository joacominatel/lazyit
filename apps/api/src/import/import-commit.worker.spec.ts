jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import type { Job } from 'bullmq';
import { ImportCommitWorker } from './import-commit.worker';
import type { CommitJobData } from './import-commit.types';

// AUD-052: flipping FAILED on a non-final attempt made every BullMQ retry die on the commit() status gate.
describe('ImportCommitWorker — failure handling across retries', () => {
  function setup() {
    const updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
    const commitService = {
      commit: jest.fn(() => Promise.reject(new Error('db blip'))),
    };
    const worker = new ImportCommitWorker(
      commitService as never,
      { importSession: { updateMany } } as never,
    );
    const job = (attemptsMade: number) =>
      ({
        data: { sessionId: 'sess-1', actorUserId: 'user-1' },
        attemptsMade,
        opts: { attempts: 3 },
        updateProgress: jest.fn(),
      }) as unknown as Job<CommitJobData>;
    return { worker, updateMany, job };
  }

  it('keeps the session COMMITTING on a non-final attempt so the retry can resume', async () => {
    const { worker, updateMany, job } = setup();
    await expect(worker.process(job(0))).rejects.toThrow('db blip');
    await expect(worker.process(job(1))).rejects.toThrow('db blip');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('marks the session FAILED on the final attempt', async () => {
    const { worker, updateMany, job } = setup();
    await expect(worker.process(job(2))).rejects.toThrow('db blip');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', status: 'COMMITTING' },
      data: {
        status: 'FAILED',
        error: { phase: 'commit', message: 'commit job failed' },
      },
    });
  });
});
