import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  PrismaExceptionFilter,
  isRetryableConflict,
} from './prisma-exception.filter';

// Avoid loading the real generated client; the filter only reads `exception.code` at runtime.
jest.mock('../../generated/prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

/**
 * SEC-004 — a malformed value for a typed column (a non-uuid passed to a uuid column) raises Prisma
 * P2023, which previously fell through the filter to a 500. It must now map to 400, without
 * regressing the existing P2002/P2003/P2025 mappings or the delegate-unknown-to-500 behavior.
 */
describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;
  let superCatch: jest.SpyInstance;
  const host = {} as ArgumentsHost;

  beforeEach(() => {
    filter = new PrismaExceptionFilter();
    // Intercept the super.catch(mappedException, host) call so no HTTP adapter is needed.
    superCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });
  afterEach(() => superCatch.mockRestore());

  const mapAndGet = (code: string): unknown => {
    superCatch.mockClear();
    filter.catch({ code } as never, host);
    return (superCatch.mock.calls as unknown[][])[0][0];
  };

  it('maps P2023 (malformed value for a typed column) to 400', () => {
    const ex = mapAndGet('P2023');
    expect(ex).toBeInstanceOf(BadRequestException);
    expect((ex as BadRequestException).getStatus()).toBe(400);
  });

  it('maps P2020 (value out of range, e.g. int4 overflow) to 400', () => {
    const ex = mapAndGet('P2020');
    expect(ex).toBeInstanceOf(BadRequestException);
    expect((ex as BadRequestException).getStatus()).toBe(400);
  });

  it('still maps P2002 -> 409, P2003 -> 400, P2025 -> 404', () => {
    expect(mapAndGet('P2002')).toBeInstanceOf(ConflictException);
    expect(mapAndGet('P2003')).toBeInstanceOf(BadRequestException);
    expect(mapAndGet('P2025')).toBeInstanceOf(NotFoundException);
  });

  it('delegates an unmapped code to the base handler unchanged (500)', () => {
    const original = { code: 'P9999' };
    superCatch.mockClear();
    filter.catch(original as never, host);
    expect(superCatch).toHaveBeenCalledWith(original, host);
  });

  // #1696: a transaction aborted only because it lost a lock race rolled back and is safe to send again.
  describe('retryable lock conflicts (Postgres 40P01 / 40001)', () => {
    const raw = (originalCode: string) => ({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode } } },
    });
    const mapped = (exception: unknown): unknown => {
      superCatch.mockClear();
      filter.catch(exception as never, host);
      return (superCatch.mock.calls as unknown[][])[0][0];
    };

    it('maps P2034 (a model call aborted by a deadlock or write conflict) to a retryable 409', () => {
      const ex = mapped({ code: 'P2034' });
      expect(ex).toBeInstanceOf(ConflictException);
      expect((ex as ConflictException).message).toMatch(/Try again/);
    });

    it.each(['40P01', '40001'])(
      'maps a raw query aborted with %s to a retryable 409',
      (pg) => {
        expect(mapped(raw(pg))).toBeInstanceOf(ConflictException);
      },
    );

    it('leaves any other raw query failure to the base handler (500)', () => {
      const original = raw('42601');
      expect(mapped(original)).toBe(original);
    });

    it('isRetryableConflict tells them apart', () => {
      expect(isRetryableConflict({ code: 'P2034' } as never)).toBe(true);
      expect(isRetryableConflict(raw('40P01') as never)).toBe(true);
      expect(isRetryableConflict(raw('23505') as never)).toBe(false);
      expect(isRetryableConflict({ code: 'P2010' } as never)).toBe(false);
      expect(isRetryableConflict({ code: 'P2002' } as never)).toBe(false);
    });
  });
});
