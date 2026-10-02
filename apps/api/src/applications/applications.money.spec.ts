// The service imports the generated Prisma client (types only at runtime); stub it so no real client
// loads. The fake delegates below stand in for the database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// SearchService pulls the ESM `meilisearch` package; it is replaced by a mock, this stops the import.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ArticlesService } from '../articles/articles.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

/**
 * `Application.costPerSeat` as 64-bit minor units (ADR-0100) over real HTTP: Express, Nest routing, the
 * global zod pipe, the real controller and service. The fake Prisma returns `costPerSeat` as a JS
 * `bigint`, exactly as the real client does for a `BigInt` column — an unconverted row would make
 * `JSON.stringify` throw and the request answer 500 instead of the amount.
 */

const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
const ABOVE_INT4 = 3_000_000_000;

class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req.user = USER;
    req.principal = { kind: 'human', user: USER };
    return true;
  }
}

type Row = Record<string, unknown>;

/** What the real client hands back for a `BigInt` column: a `bigint`, whatever number type was written. */
function asStored(data: Row): Row {
  return typeof data.costPerSeat === 'number'
    ? { ...data, costPerSeat: BigInt(data.costPerSeat) }
    : { ...data };
}

describe('Application costPerSeat over HTTP — 64-bit minor units (ADR-0100)', () => {
  let app: INestApplication<App>;
  const rows = new Map<string, Row>();
  let nextId = 0;

  const application = {
    create: jest.fn(({ data }: { data: Row }) => {
      nextId += 1;
      const id = `clh1abc0000xyz0000000p${String(nextId).padStart(3, '0')}`;
      const row = asStored({
        id,
        description: null,
        url: null,
        vendor: null,
        categoryId: null,
        isCritical: false,
        metadata: null,
        notes: null,
        seatsPurchased: null,
        costPerSeat: null,
        renewalDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...data,
      });
      rows.set(id, row);
      return Promise.resolve({ ...row });
    }),
    update: jest.fn(({ where, data }: { where: { id: string }; data: Row }) => {
      const row = asStored({ ...rows.get(where.id), ...data });
      rows.set(where.id, row);
      return Promise.resolve({ ...row });
    }),
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.has(where.id) ? { ...rows.get(where.id) } : null),
    ),
    findMany: jest.fn(() =>
      Promise.resolve([...rows.values()].map((row) => ({ ...row }))),
    ),
    count: jest.fn(() => Promise.resolve(rows.size)),
  };
  const prisma = {
    application,
    accessGrant: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ApplicationsController],
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SearchService,
          useValue: { upsert: jest.fn(), remove: jest.fn() },
        },
        { provide: AccessGrantsService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
        { provide: APP_GUARD, useClass: SignedInGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rows.clear();
    jest.clearAllMocks();
  });

  const http = () => request(app.getHttpServer());

  it('creates with costPerSeat above int4, stores bigint, and reads it back exactly (detail and list)', async () => {
    const created = await http()
      .post('/applications')
      .send({ name: 'ERP', costPerSeat: ABOVE_INT4 })
      .expect(201);
    expect(created.body).toMatchObject({ costPerSeat: ABOVE_INT4 });
    const data = (application.create.mock.calls[0] as [{ data: Row }])[0].data;
    expect(data.costPerSeat).toBe(BigInt(ABOVE_INT4));

    const id = (created.body as { id: string }).id;
    const read = await http().get(`/applications/${id}`).expect(200);
    expect(read.body).toMatchObject({ costPerSeat: ABOVE_INT4, seatsUsed: 0 });

    const list = await http().get('/applications').expect(200);
    expect(list.body).toMatchObject({
      items: [{ id, costPerSeat: ABOVE_INT4 }],
    });
  });

  it('updates costPerSeat above int4 and reads it back exactly', async () => {
    const created = await http()
      .post('/applications')
      .send({ name: 'CRM', costPerSeat: 1_299 })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const updated = await http()
      .patch(`/applications/${id}`)
      .send({ costPerSeat: ABOVE_INT4 + 1 })
      .expect(200);
    expect(updated.body).toMatchObject({ costPerSeat: ABOVE_INT4 + 1 });
    const read = await http().get(`/applications/${id}`).expect(200);
    expect(read.body).toMatchObject({ costPerSeat: ABOVE_INT4 + 1 });
  });

  it('rejects a costPerSeat above Number.MAX_SAFE_INTEGER with a 400 before any write', async () => {
    await http()
      .post('/applications')
      .send({ name: 'ERP', costPerSeat: Number.MAX_SAFE_INTEGER + 2 })
      .expect(400);
    expect(application.create).not.toHaveBeenCalled();
  });

  it('keeps null and ordinary amounts unchanged, through the soft delete and the restore', async () => {
    const created = await http()
      .post('/applications')
      .send({ name: 'Wiki', costPerSeat: 1_299 })
      .expect(201);
    expect(created.body).toMatchObject({ costPerSeat: 1_299 });
    const id = (created.body as { id: string }).id;

    const cleared = await http()
      .patch(`/applications/${id}`)
      .send({ costPerSeat: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ costPerSeat: null });

    await http()
      .patch(`/applications/${id}`)
      .send({ costPerSeat: ABOVE_INT4 })
      .expect(200);
    const removed = await http().delete(`/applications/${id}`).expect(200);
    expect(removed.body).toMatchObject({ costPerSeat: ABOVE_INT4 });
    const restored = await http()
      .post(`/applications/${id}/restore`)
      .expect(201);
    expect(restored.body).toMatchObject({ costPerSeat: ABOVE_INT4 });
  });

  it('restoring a live application (the idempotent branch) returns costPerSeat as a number', async () => {
    const created = await http()
      .post('/applications')
      .send({ name: 'Live', costPerSeat: ABOVE_INT4 })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const restored = await http()
      .post(`/applications/${id}/restore`)
      .expect(201);
    expect(restored.body).toMatchObject({ costPerSeat: ABOVE_INT4 });
    expect(application.update).not.toHaveBeenCalled();
  });
});
