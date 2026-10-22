import 'reflect-metadata';
import { Test } from '@nestjs/testing';
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { INestApplication } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import type { Permission } from '@lazyit/shared';
import request from 'supertest';
import type { Server } from 'node:http';
import { SoftwareWatchController } from './software-watch.controller';
import { SoftwareWatchService } from './software-watch.service';
import { PERMISSION_KEY } from '../auth/require-permission.decorator';
import { HumanOnlyGuard } from '../secret-manager/human-only.guard';

function permsOf(method: keyof SoftwareWatchController): Permission[] {
  const handler = Reflect.get(
    SoftwareWatchController.prototype,
    method,
  ) as object;
  return (Reflect.getMetadata(PERMISSION_KEY, handler) as Permission[]) ?? [];
}

function guardsOf(method: keyof SoftwareWatchController): unknown[] {
  const handler = Reflect.get(
    SoftwareWatchController.prototype,
    method,
  ) as object;
  return (Reflect.getMetadata('__guards__', handler) as unknown[]) ?? [];
}

describe('SoftwareWatchController — permission gating (#1684)', () => {
  it('gates every READ on infra:read (the gate the per-node package list already sits behind)', () => {
    expect(permsOf('list')).toEqual(['infra:read']);
    expect(permsOf('get')).toEqual(['infra:read']);
    expect(permsOf('listHosts')).toEqual(['infra:read']);
    // Reads are open to service accounts holding infra:read, like every other infra read.
    expect(guardsOf('list')).not.toContain(HumanOnlyGuard);
  });

  it('gates every WRITE on infra:manage AND human-only', () => {
    for (const method of ['create', 'remove'] as const) {
      expect(permsOf(method)).toEqual(['infra:manage']);
      expect(guardsOf(method)).toContain(HumanOnlyGuard);
    }
  });

  it('no route is reachable with the reporting agent permission (infra:report)', () => {
    for (const method of [
      'list',
      'get',
      'listHosts',
      'create',
      'remove',
    ] as const) {
      expect(permsOf(method)).not.toContain('infra:report');
    }
  });
});

describe('SoftwareWatchController — HTTP contract (#1684)', () => {
  let app: INestApplication;
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    listHosts: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SoftwareWatchController],
      providers: [
        { provide: SoftwareWatchService, useValue: service },
        // The production body pipe, so the create body is parsed (and normalized) exactly as live.
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      // The human-only refusal is the guard's own concern (pinned in its spec); here it passes.
      .overrideGuard(HumanOnlyGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.listHosts.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    service.create.mockImplementation((dto: { name: string }) =>
      Promise.resolve({ id: 'w', name: dto.name }),
    );
  });

  const server = () => app.getHttpServer() as Server;

  it('POST normalizes the name before the service sees it', async () => {
    await request(server())
      .post('/infra/software-watches')
      .send({ name: '  OpenSSL ' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith({ name: 'openssl' }, undefined);
  });

  it('POST refuses a blank name and any extra key (400)', async () => {
    await request(server())
      .post('/infra/software-watches')
      .send({ name: '   ' })
      .expect(400);
    await request(server())
      .post('/infra/software-watches')
      .send({ name: 'curl', createdById: 'x' })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('GET hosts parses presence, version and the page window', async () => {
    await request(server())
      .get(
        '/infra/software-watches/w1/hosts?presence=INSTALLED&version=3.0.13&limit=10&page=2',
      )
      .expect(200);
    expect(service.listHosts).toHaveBeenCalledWith(
      'w1',
      { presence: 'INSTALLED', version: '3.0.13' },
      expect.objectContaining({ limit: 10, offset: 10 }),
    );
  });

  it('GET hosts maps an EMPTY version to the null bucket', async () => {
    await request(server())
      .get('/infra/software-watches/w1/hosts?version=')
      .expect(200);
    expect(service.listHosts).toHaveBeenCalledWith(
      'w1',
      { version: null },
      expect.anything(),
    );
  });

  it.each([
    ['an unknown presence', 'presence=GONE'],
    ['a version with a non-INSTALLED presence', 'presence=MISSING&version=1'],
    ['an unknown key', 'sort=label'],
    ['an over-max limit', 'limit=201'],
    ['a repeated key', 'presence=MISSING&presence=UNKNOWN'],
  ])('GET hosts refuses %s (400)', async (_label, qs) => {
    await request(server())
      .get(`/infra/software-watches/w1/hosts?${qs}`)
      .expect(400);
    expect(service.listHosts).not.toHaveBeenCalled();
  });
});
