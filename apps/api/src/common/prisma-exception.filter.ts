import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client';

/**
 * Maps Prisma known-request errors to clean HTTP responses (the global exception filter that
 * ADR-0013 anticipated; see docs/03-decisions/0018-api-documentation-swagger.md):
 *
 *   P2002  unique constraint failed -> 409 Conflict
 *   P2003  FK constraint failed     -> 400 Bad Request (e.g. an invalid locationId/modelId/categoryId)
 *   P2025  record not found         -> 404 Not Found
 *   P2023  inconsistent column data -> 400 Bad Request (e.g. a malformed value for a uuid column)
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
          new BadRequestException('Invalid input format for one or more fields'),
          host,
        );
      default:
        return super.catch(exception, host);
    }
  }
}
