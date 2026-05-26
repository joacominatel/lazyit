import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../../generated/prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { PrismaExceptionFilter } from './prisma-exception.filter';

describe('AllExceptionsFilter', () => {
  let logger: { error: jest.Mock; setContext: jest.Mock };
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
    logger = { error: jest.fn(), setContext: jest.fn() };
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

  it('sets the logger context on construction', () => {
    expect(logger.setContext).toHaveBeenCalledWith('AllExceptionsFilter');
  });
});
