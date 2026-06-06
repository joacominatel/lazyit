import { Test } from '@nestjs/testing';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

describe('HealthService', () => {
  let service: HealthService;
  let queryRaw: jest.Mock;
  let logger: { error: jest.Mock };

  beforeEach(async () => {
    queryRaw = jest.fn();
    logger = { error: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        {
          provide: getLoggerToken(HealthService.name),
          useValue: logger as unknown as PinoLogger,
        },
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

  it('reports NOT ready when the DB probe throws (generic, non-revealing detail)', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    const report = await service.readiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('error');
    expect(report.checks.database).toEqual({
      status: 'down',
      error: 'unreachable',
    });
  });

  // SEC-070: the @Public() readiness body must never echo the raw pg driver message — a connection
  // failure embeds the internal DB host/IP + port. The boolean ready + status:'down' already drive
  // orchestrators; the real cause goes to the server log (ADR-0031), not the public 503 body.
  it('does not leak the raw driver message (host/IP/port) on a DB connection failure', async () => {
    const raw = 'connect ECONNREFUSED 172.18.0.2:5432';
    queryRaw.mockRejectedValue(new Error(raw));

    const report = await service.readiness();

    expect(report.ready).toBe(false);
    const detail = report.checks.database.error ?? '';
    expect(detail).not.toContain(raw);
    expect(detail).not.toContain('172.18.0.2');
    expect(detail).not.toContain('5432');
    expect(detail).not.toContain('ECONNREFUSED');
  });

  it('logs the rich error server-side when the DB probe throws (ADR-0031)', async () => {
    const err = new Error('connect ECONNREFUSED 172.18.0.2:5432');
    queryRaw.mockRejectedValue(err);

    await service.readiness();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      expect.any(String),
    );
  });
});
