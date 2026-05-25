import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const uuidSchema = z.uuid();

/**
 * Validate an optional uuid query filter before it reaches a `uuid`-typed Prisma column.
 *
 * The global ZodValidationPipe only validates `@Body()` DTOs, so raw `@Query` strings are otherwise
 * unchecked — a malformed value would cast-error in Postgres and surface as a 500 (SEC-004). This
 * mirrors the inline `status` check in articles.controller.ts: `undefined` passes through (filter
 * absent), a well-formed uuid is returned, anything else is a 400.
 */
export function parseUuidQuery(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!uuidSchema.safeParse(value).success) {
    throw new BadRequestException(`Invalid ${name}: expected a UUID`);
  }
  return value;
}
