// GET /audit/logs/export over real HTTP (ADR-0103): the real controller, guard, permission resolver, audit
// service and export engine; only the database is a fake.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { randomUUID } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  AUDIT_LOG_CSV_HEADER,
  DATA_EXPORT_ROW_CAP,
  DEFAULT_ROLE_PERMISSIONS,
  type Role,
} from '@lazyit/shared';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

/** `?role=` impersonates a human of that role; a fresh id per request keeps the export limiter out of the way. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const role = (req.query as Record<string, string>).role;
    const user = { id: randomUUID(), role };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

interface ExportLogRow {
  id: number;
  resource: string;
  actorId: string | null;
  serviceAccountId: string | null;
  filters: unknown;
  rowCount: number;
  createdAt: Date;
}

describe('GET /audit/logs/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  let table: ExportLogRow[] = [];
  const findMany = jest.fn(
    (args: { where: { id?: { lt: number } }; take: number; skip: number }) => {
      const lt = args.where.id?.lt ?? Infinity;
      return Promise.resolve(
        table
          .filter((r) => r.id < lt)
          .sort((a, b) => b.id - a.id)
          .slice(args.skip, args.skip + args.take),
      );
    },
  );
  const count = jest.fn(() => Promise.resolve(table.length));
  const create = jest.fn().mockResolvedValue({});
  const prisma = {
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    dataExportLog: { findMany, count, create },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: ADMIN_ID, firstName: '=Ana', lastName: 'Admin' },
        ]),
    },
    serviceAccount: { findMany: jest.fn().mockResolvedValue([]) },
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        Reflector,
        AuditService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
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
    table = [
      {
        id: 1,
        resource: 'ASSETS',
        actorId: ADMIN_ID,
        serviceAccountId: null,
        filters: { q: 'dell' },
        rowCount: 12,
        createdAt: new Date('2026-10-16T09:00:00.000Z'),
      },
      {
        id: 2,
        resource: 'USERS',
        actorId: ADMIN_ID,
        serviceAccountId: null,
        filters: {},
        rowCount: 3,
        createdAt: new Date('2026-10-16T10:00:00.000Z'),
      },
    ];
    findMany.mockClear();
    count.mockClear();
    create.mockClear();
  });

  const exportCsv = (query: string) =>
    request(app.getHttpServer())
      .get(`/audit/logs/export?${query}`)
      .buffer(true)
      .parse((res, done) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => done(null, body));
      });

  it('is logs:read like the list: a VIEWER and a MEMBER are refused both', async () => {
    for (const role of ['VIEWER', 'MEMBER']) {
      await request(app.getHttpServer())
        .get(`/audit/logs?role=${role}&source=export`)
        .expect(403);
      await exportCsv(`role=${role}&source=export`).expect(403);
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('exports the export log itself: BOM, the pinned header, no stamp, newest first, guarded', async () => {
    const res = await exportCsv('role=ADMIN&source=export').expect(200);

    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-audit-export-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.body).toBe(
      `\uFEFF${AUDIT_LOG_CSV_HEADER}\r\n` +
        `2026-10-16T10:00:00.000Z,export,USERS,'=Ana Admin,,,,,,,,"{""rowCount"":3,""filters"":{}}"\r\n` +
        `2026-10-16T09:00:00.000Z,export,ASSETS,'=Ana Admin,,,,,,,,"{""rowCount"":12,""filters"":{""q"":""dell""}}"\r\n`,
    );
  });

  it('reads the same rows as the list for the same filters, and records the export as source `export`', async () => {
    const filters = `source=export&action=ASSETS&actorId=${ADMIN_ID}&from=2026-10-01T00:00:00.000Z`;
    await request(app.getHttpServer())
      .get(`/audit/logs?role=ADMIN&${filters}`)
      .expect(200);
    await exportCsv(`role=ADMIN&${filters}`).expect(200);

    const wheres = (findMany.mock.calls as Array<[{ where: unknown }]>).map(
      ([args]) => args.where,
    );
    const counts = (count.mock.calls as unknown as Array<[{ where: unknown }]>)
      .map(([args]) => args.where)
      .filter((w) => JSON.stringify(w) !== '{"id":-1}');
    expect(wheres[1]).toEqual(wheres[0]);
    expect(counts).toEqual([wheres[0], wheres[0]]);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'AUDIT',
        rowCount: 2,
        filters: {
          source: 'export',
          action: 'ASSETS',
          actorId: ADMIN_ID,
          from: '2026-10-01T00:00:00.000Z',
        },
      }) as unknown,
    });
  });

  it('refuses above the cap with a 422, before any batch or audit row', async () => {
    count.mockResolvedValueOnce(DATA_EXPORT_ROW_CAP + 1);
    await exportCsv('role=ADMIN&source=export').expect(422);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect((findMany.mock.calls[0] as [{ take: number }])[0].take).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});
