import { Test } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

describe('HealthService', () => {
  let service: HealthService;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    queryRaw = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    service = moduleRef.get(HealthService);
  });

  it('reports ready when the DB SELECT 1 succeeds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const report = await service.readiness();

    expect(report).toEqual({
      status: 'ok',
      ready: true,
      checks: { database: { status: 'up' } },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports NOT ready (with the error summary) when the DB probe throws', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    const report = await service.readiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('error');
    expect(report.checks.database).toEqual({
      status: 'down',
      error: 'connection refused',
    });
  });
});
