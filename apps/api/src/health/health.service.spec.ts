import { Test } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import { HEALTH_REDIS } from './health-redis';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

describe('HealthService', () => {
  let service: HealthService;
  let queryRaw: jest.Mock;
  let ping: jest.Mock;

  beforeEach(async () => {
    queryRaw = jest.fn();
    ping = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        { provide: HEALTH_REDIS, useValue: { ping } },
      ],
    }).compile();
    service = moduleRef.get(HealthService);
  });

  it('reports ready + ok when the DB SELECT 1 and the Valkey PING both succeed', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockResolvedValue('PONG');

    const report = await service.readiness();

    expect(report).toEqual({
      status: 'ok',
      ready: true,
      checks: {
        database: { status: 'up' },
        valkey: { status: 'up' },
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('reports NOT ready (status error) when the DB probe throws, regardless of Valkey', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));
    ping.mockResolvedValue('PONG');

    const report = await service.readiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('error');
    expect(report.checks.database).toEqual({
      status: 'down',
      error: 'connection refused',
    });
    // Valkey being up cannot rescue an unready DB.
    expect(report.checks.valkey).toEqual({ status: 'up' });
  });

  it('stays ready but DEGRADED (non-gating) when the DB is up but the Valkey PING fails', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockRejectedValue(new Error("Stream isn't writeable"));

    const report = await service.readiness();

    // The broker is transport, not the record — a Valkey outage must NOT pull the instance from rotation.
    expect(report.ready).toBe(true);
    expect(report.status).toBe('degraded');
    expect(report.checks.database).toEqual({ status: 'up' });
    expect(report.checks.valkey).toEqual({
      status: 'down',
      error: "Stream isn't writeable",
    });
  });

  it('treats an unexpected PING reply as Valkey down (degraded), still ready', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockResolvedValue('LOADING');

    const report = await service.readiness();

    expect(report.ready).toBe(true);
    expect(report.status).toBe('degraded');
    expect(report.checks.valkey).toEqual({
      status: 'down',
      error: 'unexpected PING reply: LOADING',
    });
  });
});
