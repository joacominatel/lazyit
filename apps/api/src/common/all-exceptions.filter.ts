import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../../generated/prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * The single global exception filter (ADR-0031).
 *
 * 1. Logs every fault that resolves to **HTTP >= 500** (including unhandled/unknown errors) at
 *    `error` level — CRITICAL in our category vocabulary — with the exception and its stack
 *    attached. The request id rides the log automatically via nestjs-pino's request context.
 * 2. Delegates the HTTP response: Prisma known-request errors go to {@link PrismaExceptionFilter}
 *    (its P-code -> 4xx mapping is preserved untouched), everything else to Nest's
 *    `BaseExceptionFilter`.
 *
 * 4xx responses are intentionally **not** error-logged here: pino-http autoLogging already records
 * every request/response (4xx at `warn`), so logging them again would be duplicate noise. Using a
 * single catch-all filter that *delegates* avoids the ordering ambiguity of two competing global
 * filters.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly prismaFilter: PrismaExceptionFilter,
  ) {
    super();
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (this.httpStatusOf(exception) >= 500) {
      this.logger.error({ err: exception }, 'Unhandled server error');
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      this.prismaFilter.catch(exception, host);
      return;
    }

    super.catch(exception, host);
  }

  /**
   * The HTTP status an exception will resolve to — used only to decide the log level. Mirrors the
   * P-code mapping in {@link PrismaExceptionFilter}; anything unrecognized is a 500.
   */
  private httpStatusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return 409;
        case 'P2003':
        case 'P2023':
          return 400;
        case 'P2025':
          return 404;
        default:
          return 500;
      }
    }
    return 500;
  }
}
