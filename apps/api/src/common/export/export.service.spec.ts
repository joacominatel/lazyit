import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import {
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '../../auth/principal';
import type { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../actor.service';
import type { ExportColumn } from './export-column';
import { ExportLimiter, EXPORT_RATE_LIMIT } from './export-limiter';
import {
  ExportService,
  sanitizeExportFilters,
  type CsvExportSpec,
} from './export.service';
import type { KeysetCursor } from './keyset';

jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

interface Row extends KeysetCursor<string> {
  name: string;
}

const HUMAN = {
  kind: 'human',
  user: { id: '11111111-1111-4111-8111-111111111111' },
} as unknown as Principal;
const BOT = {
  kind: 'service',
  serviceAccount: { id: 'sa1' },
  permissions: new Set(),
} as unknown as Principal;

const COLUMNS: ExportColumn<Row>[] = [
  { header: 'name', kind: 'text', value: (r) => r.name },
];

function setup() {
  const create = jest.fn().mockResolvedValue({});
  const prisma = { dataExportLog: { create } } as unknown as PrismaService;
  const service = new ExportService(
    prisma,
    new ActorService(),
    new ExportLimiter(),
  );
  return { service, create };
}

function response(): Response & EventEmitter {
  return new EventEmitter() as Response & EventEmitter;
}

function spec(overrides: Partial<CsvExportSpec<Row>> = {}): CsvExportSpec<Row> {
  const rows: Row[] = [
    { id: 'b', createdAt: new Date('2026-10-16T10:00:02.000Z'), name: 'Dock' },
    { id: 'a', createdAt: new Date('2026-10-16T10:00:01.000Z'), name: '=x' },
  ];
  return {
    resource: 'USERS',
    principal: HUMAN,
    response: response(),
    filters: { q: 'ana', role: undefined },
    count: () => Promise.resolve(rows.length),
    fetchBatch: (after) => Promise.resolve(after ? [] : rows),
    columns: COLUMNS,
    filename: 'users',
    ...overrides,
  };
}

async function drain(file: { getStream(): NodeJS.ReadableStream }) {
  let out = '';
  for await (const chunk of file.getStream()) out += String(chunk);
  return out;
}

describe('ExportService.exportCsv', () => {
  it('streams BOM, header and guarded rows, and writes one audit row with the pre-count', async () => {
    const { service, create } = setup();
    const file = await service.exportCsv(spec());

    expect(await drain(file)).toBe("\uFEFFname\r\nDock\r\n'=x\r\n");
    const headers = file.getHeaders();
    expect(headers.type).toBe('text/csv; charset=utf-8');
    expect(headers.disposition).toMatch(
      /^attachment; filename="lazyit-users-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: '11111111-1111-4111-8111-111111111111',
        serviceAccountId: null,
        resource: 'USERS',
        filters: { q: 'ana' },
        rowCount: 2,
      },
    });
  });

  it('attributes a service-account export to the account, never a human', async () => {
    const { service, create } = setup();
    await drain(await service.exportCsv(spec({ principal: BOT })));
    const [[call]] = create.mock.calls as [[{ data: unknown }]];
    expect(call.data).toMatchObject({
      actorId: null,
      serviceAccountId: 'sa1',
    });
  });

  it('adds the provenance stamp only when the spec asks for it', async () => {
    const { service } = setup();
    const csv = await drain(await service.exportCsv(spec({ stamp: true })));
    expect(csv).toMatch(/^\uFEFF# lazyit \S+ — \S+\r\nname\r\n/);
  });

  it('refuses above the cap before any byte, any batch or any audit row', async () => {
    const { service, create } = setup();
    const fetchBatch = jest.fn();
    await expect(
      service.exportCsv(
        spec({ count: () => Promise.resolve(100_001), fetchBatch }),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(fetchBatch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    // The refusal freed the principal's slot.
    await expect(service.exportCsv(spec())).resolves.toBeDefined();
  });

  it('accepts exactly the cap', async () => {
    const { service } = setup();
    await expect(
      service.exportCsv(spec({ count: () => Promise.resolve(100_000) })),
    ).resolves.toBeDefined();
  });

  it('refuses a second concurrent export by the same principal until the first closes', async () => {
    const { service } = setup();
    const first = await service.exportCsv(spec());

    await expect(service.exportCsv(spec())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    // Another principal is not affected.
    await expect(
      service.exportCsv(spec({ principal: BOT })),
    ).resolves.toBeDefined();

    await drain(first);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.exportCsv(spec())).resolves.toBeDefined();
  });

  it('frees the slot when the client disconnects mid-download', async () => {
    const { service } = setup();
    const res = response();
    await service.exportCsv(spec({ response: res }));

    res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.exportCsv(spec())).resolves.toBeDefined();
  });

  it('frees the slot when the client left before the stream was built', async () => {
    const { service } = setup();
    const res = Object.assign(response(), { destroyed: true });
    await service.exportCsv(spec({ response: res }));

    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.exportCsv(spec())).resolves.toBeDefined();
  });
});

describe('ExportLimiter', () => {
  it(`allows ${EXPORT_RATE_LIMIT.max} exports per window, then refuses`, () => {
    const limiter = new ExportLimiter();
    for (let i = 0; i < EXPORT_RATE_LIMIT.max; i++)
      limiter.acquire('k', 1000)();
    expect(() => limiter.acquire('k', 1000)).toThrow(HttpException);
    expect(() =>
      limiter.acquire('k', 1000 + EXPORT_RATE_LIMIT.windowMs),
    ).not.toThrow();
  });

  it('a stale release does not free a newer lease', () => {
    const limiter = new ExportLimiter();
    const release = limiter.acquire('k', 0);
    release();
    limiter.acquire('k', 1);
    release();
    expect(() => limiter.acquire('k', 2)).toThrow(HttpException);
  });
});

describe('sanitizeExportFilters', () => {
  it('keeps flat scalars and scalar arrays, drops the rest', () => {
    expect(
      sanitizeExportFilters({
        q: 'x'.repeat(500),
        status: ['IN_USE', { nested: true }, 'IN_STOCK'],
        deleted: 'active',
        limit: 10,
        isActive: false,
        from: new Date('2026-10-16T00:00:00.000Z'),
        empty: '',
        none: undefined,
        nested: { a: 1 },
        'bad key': 'x',
        nan: Number.NaN,
      }),
    ).toEqual({
      q: 'x'.repeat(200),
      status: ['IN_USE', 'IN_STOCK'],
      deleted: 'active',
      limit: 10,
      isActive: false,
      from: '2026-10-16T00:00:00.000Z',
    });
  });
});
