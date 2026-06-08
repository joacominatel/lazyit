import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';

// HealthController -> HealthService -> PrismaService statically imports the generated Prisma client;
// stub it so jest never loads the real one (HealthService is mocked below anyway).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

describe('HealthController', () => {
  let app: INestApplication;
  const readiness = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { readiness } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => readiness.mockReset());

  it('GET /health/live always returns 200 { status: ok } (no dependency check)', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(readiness).not.toHaveBeenCalled();
  });

  it('GET /health/ready returns 200 with the report when the DB is up', async () => {
    readiness.mockResolvedValue({
      status: 'ok',
      ready: true,
      checks: {
        database: { status: 'up' },
        valkey: { status: 'up' },
      },
    });

    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });

  it('GET /health/ready stays 200 when Valkey is down (degraded, non-gating)', async () => {
    readiness.mockResolvedValue({
      status: 'degraded',
      ready: true,
      checks: {
        database: { status: 'up' },
        valkey: { status: 'down', error: "Stream isn't writeable" },
      },
    });

    const res = await request(app.getHttpServer()).get('/health/ready');
    // The broker is transport, not the record — a Valkey outage must not 503 the instance.
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.valkey.status).toBe('down');
  });

  it('GET /health/ready returns 503 (carrying the report) when the DB is down', async () => {
    readiness.mockResolvedValue({
      status: 'error',
      ready: false,
      checks: {
        database: { status: 'down', error: 'connection refused' },
        valkey: { status: 'up' },
      },
    });

    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(503);
    // ServiceUnavailableException wraps the report as the response body.
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.database.status).toBe('down');
  });

  it('both probes are flagged @Public() so the global auth guard lets them through', () => {
    const reflector = new Reflector();
    const controller = new HealthController({} as never);
    expect(
      reflector.get<boolean>(IS_PUBLIC_KEY, controller.live),
    ).toBe(true);
    expect(
      reflector.get<boolean>(IS_PUBLIC_KEY, controller.ready),
    ).toBe(true);
  });
});
