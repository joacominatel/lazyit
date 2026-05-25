import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PrismaExceptionFilter } from './prisma-exception.filter';

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
    return superCatch.mock.calls[0][0];
  };

  it('maps P2023 (malformed value for a typed column) to 400', () => {
    const ex = mapAndGet('P2023');
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
});
