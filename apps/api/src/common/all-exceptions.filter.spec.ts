import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../../generated/prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { PrismaExceptionFilter } from './prisma-exception.filter';

// Mock the generated Prisma client so jest never loads its real ESM internals (its `./internal/*.js`
// imports do not resolve under the jest resolver). The stub is a real class so the errors we build
// below match the filter's `instanceof Prisma.PrismaClientKnownRequestError` check.
jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      meta?: Record<string, unknown>;
      constructor(
        message: string,
        opts: { code: string; meta?: Record<string, unknown> },
      ) {
        super(message);
        this.code = opts.code;
        this.meta = opts.meta;
      }
    },
  },
}));

describe('AllExceptionsFilter', () => {
  let logger: { error: jest.Mock; warn: jest.Mock; setContext: jest.Mock };
  let prismaFilter: { catch: jest.Mock };
  let filter: AllExceptionsFilter;
  let superCatch: jest.SpyInstance;
  const host = {} as ArgumentsHost;

  const prismaError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('x', {
      code,
      clientVersion: 'test',
    });

  beforeEach(() => {
    logger = { error: jest.fn(), warn: jest.fn(), setContext: jest.fn() };
    prismaFilter = { catch: jest.fn() };
    filter = new AllExceptionsFilter(
      logger as unknown as PinoLogger,
      prismaFilter as unknown as PrismaExceptionFilter,
    );
    // Stub BaseExceptionFilter.catch — it needs an HTTP adapter we don't wire in a unit test.
    superCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('error-logs unknown faults (500) and delegates to BaseExceptionFilter', () => {
    const err = new Error('boom');
    filter.catch(err, host);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(prismaFilter.catch).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(err, host);
  });

  it('does not error-log handled 4xx HttpExceptions (autoLogging covers them)', () => {
    const err = new NotFoundException();
    filter.catch(err, host);
    expect(logger.error).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(err, host);
  });

  it('delegates Prisma known errors to PrismaExceptionFilter without touching super', () => {
    const err = prismaError('P2002'); // -> 409
    filter.catch(err, host);
    expect(prismaFilter.catch).toHaveBeenCalledWith(err, host);
    expect(superCatch).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled(); // 409 < 500
  });

  it('error-logs an unknown Prisma code (500) and still delegates the mapping', () => {
    const err = prismaError('P9999');
    filter.catch(err, host);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(prismaFilter.catch).toHaveBeenCalledWith(err, host);
  });

  // #1696: a lost lock race answers a retryable 503. A deadlock is a lock-order bug, so it stays an error; a
  // serialization failure is expected contention, so it is a warning.
  const raced = (code: string, originalCode?: string) =>
    new Prisma.PrismaClientKnownRequestError('x', {
      code,
      clientVersion: 'test',
      ...(originalCode
        ? { meta: { driverAdapterError: { cause: { originalCode } } } }
        : {}),
    });

  it.each([
    ['a raw query deadlock (P2010 / 40P01)', raced('P2010', '40P01')],
    ['a model call deadlock (P2034 / 40P01)', raced('P2034', '40P01')],
    ['a P2034 with no driver code', raced('P2034')],
  ])(
    'error-logs %s as a lock-order bug, once, and delegates the 503',
    (_what, err) => {
      filter.catch(err, host);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect((logger.error.mock.calls as unknown[][])[0][1]).toMatch(
        /deadlock/,
      );
      expect(logger.warn).not.toHaveBeenCalled();
      expect(prismaFilter.catch).toHaveBeenCalledWith(err, host);
    },
  );

  it('warn-logs a serialization failure (40001) instead of error-logging it', () => {
    const err = raced('P2010', '40001');
    filter.catch(err, host);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(prismaFilter.catch).toHaveBeenCalledWith(err, host);
  });

  it('sets the logger context on construction', () => {
    expect(logger.setContext).toHaveBeenCalledWith('AllExceptionsFilter');
  });
});
