import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import {
  HttpException,
  HttpStatus,
  Logger,
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
import { XLSX_CONTENT_TYPE } from './stream-xlsx';
import { XLSX_STYLE } from './xlsx-sheet';
import {
  collectBuffer,
  readXlsx,
  xlsxRecords,
} from '../../../test/xlsx-reader';

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

describe('ExportService.exportCsv — a batch failing mid-stream', () => {
  it('destroys the response instead of ending it, logs the error and frees the slot', async () => {
    const { service } = setup();
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const res = response();
    const destroy = jest.fn(() => res.emit('close'));
    const end = jest.fn();
    Object.assign(res, { destroy, end, destroyed: false, headersSent: true });

    const boom = new Error('db down');
    let calls = 0;
    const fetchBatch = (_after: KeysetCursor | null, take: number) => {
      calls += 1;
      if (calls > 1) return Promise.reject(boom);
      return Promise.resolve(
        Array.from({ length: take }, (_, i) => ({
          id: `r${String(take - i).padStart(5, '0')}`,
          createdAt: new Date(Date.UTC(2026, 9, 16, 0, 0, 0, take - i)),
          name: 'row',
        })),
      );
    };
    const file = await service.exportCsv(spec({ response: res, fetchBatch }));

    // What the Express adapter does with a StreamableFile.
    const stream = file.getStream();
    const failed = new Promise<void>((resolve) =>
      stream.once('error', (err: Error) => {
        file.errorHandler(err, res);
        resolve();
      }),
    );
    stream.resume();
    await failed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(2);
    expect(destroy).toHaveBeenCalledWith(boom);
    expect(end).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('db down'),
      boom.stack,
    );
    await expect(service.exportCsv(spec())).resolves.toBeDefined();
    logged.mockRestore();
  });
});

describe('ExportService.exportFile — format xlsx (ADR-0103 §11)', () => {
  it('streams a workbook with the same header and rows, and records the format on the audit row', async () => {
    const { service, create } = setup();
    const file = await service.exportFile({
      ...spec({ stamp: true }),
      format: 'xlsx',
    });

    const headers = file.getHeaders();
    expect(headers.type).toBe(XLSX_CONTENT_TYPE);
    expect(headers.disposition).toMatch(
      /^attachment; filename="lazyit-users-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const read = await readXlsx(await collectBuffer(file.getStream()));
    expect(read.parts['xl/workbook.xml']).toContain('<sheet name="users"');
    // No provenance line: the header is row 1 and the formula-looking value is literal text.
    expect(read.rows.get(1)!.get('A')).toMatchObject({
      value: 'name',
      style: XLSX_STYLE.header,
    });
    expect(xlsxRecords(read).map((r) => r.name.value)).toEqual(['Dock', '=x']);
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: '11111111-1111-4111-8111-111111111111',
        serviceAccountId: null,
        resource: 'USERS',
        filters: { q: 'ana', format: 'xlsx' },
        rowCount: 2,
      },
    });
  });

  it('format csv is exactly exportCsv: no format key on the audit row', async () => {
    const { service, create } = setup();
    const file = await service.exportFile({ ...spec(), format: 'csv' });
    expect(await drain(file)).toBe("\uFEFFname\r\nDock\r\n'=x\r\n");
    const [[call]] = create.mock.calls as [[{ data: { filters: unknown } }]];
    expect(call.data.filters).toEqual({ q: 'ana' });
  });

  it('keeps the cap and the limiter: 422 above the cap, 429 while one runs, slot freed on completion', async () => {
    const { service, create } = setup();
    await expect(
      service.exportFile({
        ...spec({ count: () => Promise.resolve(100_001) }),
        format: 'xlsx',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(create).not.toHaveBeenCalled();

    const first = await service.exportFile({ ...spec(), format: 'xlsx' });
    await expect(
      service.exportFile({ ...spec(), format: 'xlsx' }),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

    await collectBuffer(first.getStream());
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      service.exportFile({ ...spec(), format: 'xlsx' }),
    ).resolves.toBeDefined();
  });

  it('frees the slot when the client disconnects mid-download', async () => {
    const { service } = setup();
    const res = response();
    await service.exportFile({ ...spec({ response: res }), format: 'xlsx' });

    res.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      service.exportFile({ ...spec(), format: 'xlsx' }),
    ).resolves.toBeDefined();
  });

  it('a batch failing mid-stream destroys the response and frees the slot', async () => {
    const { service } = setup();
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const res = response();
    const destroy = jest.fn(() => res.emit('close'));
    Object.assign(res, { destroy, destroyed: false, headersSent: true });

    const boom = new Error('db down');
    let calls = 0;
    const fetchBatch = (_after: KeysetCursor | null, take: number) => {
      calls += 1;
      if (calls > 1) return Promise.reject(boom);
      return Promise.resolve(
        Array.from({ length: take }, (_, i) => ({
          id: `r${String(take - i).padStart(5, '0')}`,
          createdAt: new Date(Date.UTC(2026, 9, 16, 0, 0, 0, take - i)),
          name: 'row',
        })),
      );
    };
    const file = await service.exportFile({
      ...spec({ response: res, fetchBatch }),
      format: 'xlsx',
    });

    const stream = file.getStream();
    const failed = new Promise<void>((resolve) =>
      stream.once('error', (err: Error) => {
        file.errorHandler(err, res);
        resolve();
      }),
    );
    stream.resume();
    await failed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(destroy).toHaveBeenCalledWith(boom);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('db down'),
      boom.stack,
    );
    await expect(
      service.exportFile({ ...spec(), format: 'xlsx' }),
    ).resolves.toBeDefined();
    logged.mockRestore();
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
