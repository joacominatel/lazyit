// The service imports the generated Prisma client (types + the known-error class); stub it so no real
// client loads. The fake delegates below stand in for the database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
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
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetTagSchemeService } from '../asset-tag-scheme/asset-tag-scheme.service';
import { ArticlesService } from '../articles/articles.service';
import { AiToolDispatcher } from '../ai/core/tool-dispatcher';
import { bind } from '../ai/core/tool-descriptor';
import { ActorService } from '../common/actor.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

/**
 * Money as 64-bit minor units (ADR-0100) over real HTTP: Express, Nest routing, the global zod pipe, the
 * real controller and service. The fake Prisma below returns money columns as JS `bigint`, exactly as the
 * real client does for a `BigInt` column — so a row that left the service unconverted would make
 * `JSON.stringify` throw and the request answer 500 instead of the amount.
 */

const USER = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
const ABOVE_INT4 = 3_000_000_000; // 30,000,000.00 — past the old int4 ceiling of 2,147,483,647.
const MONEY_COLUMNS = ['purchaseCost', 'salvageValue'] as const;

class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req.user = USER;
    req.principal = { kind: 'human', user: USER };
    return true;
  }
}

type Row = Record<string, unknown>;
type Select = Record<string, unknown>;

/** What the real client hands back for a `BigInt` column: a `bigint`, whatever number type was written. */
function asStored(data: Row): Row {
  const row: Row = { ...data };
  for (const key of MONEY_COLUMNS) {
    if (typeof row[key] === 'number') row[key] = BigInt(row[key]);
  }
  for (const key of ['purchaseDate', 'warrantyEnd']) {
    if (typeof row[key] === 'string') row[key] = new Date(row[key]);
  }
  return row;
}

/** A row shaped by `select` / `include`, with empty relations (the money path has none to load). */
function project(row: Row, args: { select?: Select; include?: Select }): Row {
  const relations: Row = { model: null, location: null, assignments: [] };
  if (args.select) {
    return Object.fromEntries(
      Object.keys(args.select).map((key) => [
        key,
        key in relations ? relations[key] : row[key],
      ]),
    );
  }
  return args.include ? { ...row, ...relations } : { ...row };
}

describe('Asset money over HTTP — 64-bit minor units (ADR-0100)', () => {
  let app: INestApplication<App>;
  const rows = new Map<string, Row>();
  let nextId = 0;

  const asset = {
    create: jest.fn(({ data }: { data: Row }) => {
      nextId += 1;
      const id = `clh1abc0000xyz0000000a${String(nextId).padStart(3, '0')}`;
      const row = asStored({
        id,
        serial: null,
        assetTag: null,
        specs: null,
        notes: null,
        company: null,
        purchaseDate: null,
        warrantyEnd: null,
        purchaseCost: null,
        usefulLifeMonths: null,
        salvageValue: null,
        purchaseCurrency: null,
        purchaseOrderLineId: null,
        modelId: null,
        locationId: null,
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
    findFirst: jest.fn(
      (args: { where: { id: string }; select?: Select; include?: Select }) => {
        const row = rows.get(args.where.id);
        return Promise.resolve(row ? project(row, args) : null);
      },
    ),
    findMany: jest.fn((args: { select?: Select }) =>
      Promise.resolve([...rows.values()].map((row) => project(row, args))),
    ),
    count: jest.fn(() => Promise.resolve(rows.size)),
  };
  const prisma = {
    asset,
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)({ asset }),
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetsController],
      providers: [
        AssetsService,
        ActorService,
        AiToolDispatcher,
        { provide: PrismaService, useValue: prisma },
        { provide: AssetHistoryService, useValue: { record: jest.fn() } },
        {
          provide: SearchService,
          useValue: { upsert: jest.fn(), remove: jest.fn() },
        },
        {
          provide: AssetTagSchemeService,
          useValue: { allocateTag: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PermissionResolverService,
          useValue: { principalHas: jest.fn().mockResolvedValue(false) },
        },
        { provide: AssetAssignmentsService, useValue: {} },
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

  it('creates with purchaseCost and salvageValue above int4, stores bigint, and reads them back exactly', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-01',
        status: 'OPERATIONAL',
        purchaseCost: ABOVE_INT4,
        salvageValue: ABOVE_INT4 - 1,
      })
      .expect(201);

    expect(created.body).toMatchObject({
      purchaseCost: ABOVE_INT4,
      salvageValue: ABOVE_INT4 - 1,
    });
    // The validated number reached Prisma as a bigint (ADR-0100 §3, writes).
    const data = (asset.create.mock.calls[0] as [{ data: Row }])[0].data;
    expect(data.purchaseCost).toBe(BigInt(ABOVE_INT4));
    expect(data.salvageValue).toBe(BigInt(ABOVE_INT4 - 1));

    const id = (created.body as { id: string }).id;
    const read = await http().get(`/assets/${id}`).expect(200);
    expect(read.body).toMatchObject({
      purchaseCost: ABOVE_INT4,
      salvageValue: ABOVE_INT4 - 1,
    });
  });

  it('updates purchaseCost and salvageValue above int4 and reads them back exactly', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-02',
        status: 'OPERATIONAL',
        purchaseCost: 150_000,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const updated = await http()
      .patch(`/assets/${id}`)
      .send({ purchaseCost: ABOVE_INT4 + 1, salvageValue: ABOVE_INT4 })
      .expect(200);
    expect(updated.body).toMatchObject({
      purchaseCost: ABOVE_INT4 + 1,
      salvageValue: ABOVE_INT4,
    });

    const read = await http().get(`/assets/${id}`).expect(200);
    expect(read.body).toMatchObject({
      purchaseCost: ABOVE_INT4 + 1,
      salvageValue: ABOVE_INT4,
    });
  });

  it('computes the book value from a large cost on the detail read', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-03',
        status: 'OPERATIONAL',
        purchaseCost: ABOVE_INT4,
        salvageValue: 300_000_000,
        usefulLifeMonths: 12,
        // Long past the end of its life: fully depreciated down to salvage, independent of "now".
        purchaseDate: '2020-01-01T00:00:00.000Z',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const read = await http().get(`/assets/${id}`).expect(200);
    expect(read.body).toMatchObject({ currentBookValue: 300_000_000 });
  });

  it('round-trips the free-text purchase currency label and clears it with null (ADR-0099 §5)', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-05',
        status: 'OPERATIONAL',
        purchaseCost: ABOVE_INT4,
        purchaseCurrency: '  u$s ',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      purchaseCost: ABOVE_INT4,
      purchaseCurrency: 'u$s',
      purchaseOrderLineId: null,
    });
    const id = (created.body as { id: string }).id;
    expect((await http().get(`/assets/${id}`).expect(200)).body).toMatchObject({
      purchaseCurrency: 'u$s',
    });

    const cleared = await http()
      .patch(`/assets/${id}`)
      .send({ purchaseCurrency: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ purchaseCurrency: null });
  });

  it('refuses purchaseOrderLineId on create and update — it is read-only until linking ships', async () => {
    const line = 'clh1abc0000xyz0000000line';
    await http()
      .post('/assets')
      .send({
        name: 'SRV-06',
        status: 'OPERATIONAL',
        purchaseOrderLineId: line,
      })
      .expect(400);
    expect(asset.create).not.toHaveBeenCalled();
  });

  it('rejects an amount above Number.MAX_SAFE_INTEGER with a 400 before any write', async () => {
    await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-04',
        status: 'OPERATIONAL',
        purchaseCost: Number.MAX_SAFE_INTEGER + 2,
      })
      .expect(400);
    expect(asset.create).not.toHaveBeenCalled();
  });

  it('keeps null and ordinary amounts unchanged', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-05',
        status: 'OPERATIONAL',
        purchaseCost: 150_000,
        salvageValue: null,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      purchaseCost: 150_000,
      salvageValue: null,
    });
    const id = (created.body as { id: string }).id;

    const cleared = await http()
      .patch(`/assets/${id}`)
      .send({ purchaseCost: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      purchaseCost: null,
      salvageValue: null,
    });
  });

  it('serializes the list, the soft delete and the restore of a large-cost asset', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-06',
        status: 'OPERATIONAL',
        purchaseCost: ABOVE_INT4,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    await http().get('/assets').expect(200);
    const removed = await http().delete(`/assets/${id}`).expect(200);
    expect(removed.body).toMatchObject({ purchaseCost: ABOVE_INT4 });
    const restored = await http().post(`/assets/${id}/restore`).expect(201);
    expect(restored.body).toMatchObject({ purchaseCost: ABOVE_INT4 });
  });

  it('the AI tool and MCP dispatch path gets JSON-safe amounts from the same handlers', async () => {
    const created = await http()
      .post('/assets')
      .send({
        name: 'SRV-ARS-07',
        status: 'OPERATIONAL',
        purchaseCost: ABOVE_INT4,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const dispatcher = app.get(AiToolDispatcher);
    const identity = {
      kind: 'human' as const,
      userId: USER.id,
      sessionEpoch: 0,
    };

    const read = await dispatcher.dispatch(
      bind(AssetsController, 'findOne'),
      identity,
      { params: { id } },
    );
    const updated = await dispatcher.dispatch(
      bind(AssetsController, 'update'),
      identity,
      { params: { id }, body: { salvageValue: ABOVE_INT4 } },
    );

    // The tool layer serializes these results (ledger, model turn, MCP reply): no bigint may survive.
    expect(JSON.parse(JSON.stringify(read))).toMatchObject({
      purchaseCost: ABOVE_INT4,
    });
    expect(JSON.parse(JSON.stringify(updated))).toMatchObject({
      purchaseCost: ABOVE_INT4,
      salvageValue: ABOVE_INT4,
    });
  });
});
