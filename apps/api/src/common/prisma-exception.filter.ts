import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';

/** Postgres codes for a transaction aborted only because of a concurrent one: a deadlock, a serialization failure. */
const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** The body `code` of a lost lock race (#1696): a transient failure, distinct from any business 409. */
export const TRANSACTION_CONFLICT = 'TRANSACTION_CONFLICT';

/** Seconds a client should wait before sending the same request again. */
const TRANSACTION_CONFLICT_RETRY_AFTER = '1';

/** The Postgres SQLSTATE the driver adapter reported under a Prisma error, when it carries one. */
export function driverCode(
  exception: Prisma.PrismaClientKnownRequestError,
): string | undefined {
  const adapter = exception.meta?.driverAdapterError as
    { cause?: { originalCode?: unknown } } | undefined;
  const code = adapter?.cause?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Whether the request lost a lock race (#1696): nothing was written (the transaction rolled back), and the same
 * request is expected to succeed when sent again. Lock orders are kept consistent (ADR-0023), so a deadlock is
 * a safety net here, not a path any documented pair of writes takes.
 */
export function isRetryableConflict(
  exception: Prisma.PrismaClientKnownRequestError,
): boolean {
  if (exception.code === 'P2034') return true;
  const code = driverCode(exception);
  return (
    exception.code === 'P2010' &&
    code !== undefined &&
    RETRYABLE_PG_CODES.has(code)
  );
}

/**
 * Maps Prisma known-request errors to clean HTTP responses (the global exception filter that
 * ADR-0013 anticipated; see docs/03-decisions/0018-api-documentation-swagger.md):
 *
 *   P2002  unique constraint failed -> 409 Conflict
 *   P2003  FK constraint failed     -> 400 Bad Request (e.g. an invalid locationId/modelId/categoryId)
 *   P2025  record not found         -> 404 Not Found
 *   P2023  inconsistent column data -> 400 Bad Request (e.g. a malformed value for a uuid column)
 *   P2020  value out of range       -> 400 Bad Request (e.g. an int4 overflow that slipped past zod)
 *   P2034  write conflict/deadlock  -> 503 `TRANSACTION_CONFLICT` + `Retry-After: 1` (Postgres 40P01 / 40001
 *                                      from a model call)
 *   P2010  raw query failed         -> the same 503 when the driver code is 40P01 or 40001 (a lock taken with
 *                                      $queryRaw); any other raw failure stays a 500
 *
 * A lost lock race is a 503, not a 409, on purpose (ADR-0023): clients read a 409 as a business conflict
 * ("nothing linkable", "folder not empty"…) and treat it as final, while this one is transient and the same
 * request should be sent again.
 *
 * Anything else is delegated to Nest's default handler (500). Only Prisma known errors are
 * caught, so validation (pipe) and our own HttpExceptions are untouched.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    if (isRetryableConflict(exception)) {
      if (host.getType?.() === 'http') {
        host
          .switchToHttp()
          .getResponse<Response>()
          .setHeader('Retry-After', TRANSACTION_CONFLICT_RETRY_AFTER);
      }
      // Generic on purpose: it must not echo the statement, the rows or the lock that crossed.
      return super.catch(
        new ServiceUnavailableException({
          statusCode: 503,
          code: TRANSACTION_CONFLICT,
          message:
            'This change ran into another one at the same moment and was not saved. Try again.',
        }),
        host,
      );
    }
    switch (exception.code) {
      case 'P2002': {
        const target = exception.meta?.target;
        const fields = Array.isArray(target) ? target.join(', ') : 'field';
        return super.catch(
          new ConflictException(`A record with this ${fields} already exists`),
          host,
        );
      }
      case 'P2003':
        return super.catch(
          new BadRequestException(
            'Invalid reference: a related record does not exist',
          ),
          host,
        );
      case 'P2025':
        return super.catch(new NotFoundException('Record not found'), host);
      case 'P2023':
        // A malformed value reached a typed column (e.g. a non-uuid passed to a uuid column).
        // That is a client input error, not a server fault, so 400 instead of a 500. The message
        // is generic on purpose — it must not echo the offending column or value. This is the
        // transversal safety net for unvalidated uuid inputs (SEC-004); request edges should still
        // validate uuids up front (ParseUUIDPipe on path params, parseUuidQuery on query filters).
        return super.catch(
          new BadRequestException(
            'Invalid input format for one or more fields',
          ),
          host,
        );
      case 'P2020':
        // A value out of range for its column type (e.g. an int4 overflow). int4-bounded zod
        // (ADR-0036) and the consumable stock overflow guard should stop this up front; this is the
        // transversal safety net so any residual overflow is a clean 400, not a 500. The message is
        // generic on purpose — it must not echo the offending column or value.
        return super.catch(
          new BadRequestException('A value is out of the allowed range'),
          host,
        );
      default:
        return super.catch(exception, host);
    }
  }
}
