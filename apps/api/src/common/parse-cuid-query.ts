import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const cuidSchema = z.cuid();

/**
 * Validate an optional cuid query filter before it reaches a `cuid`-typed Prisma column.
 *
 * The cuid counterpart of {@link parseUuidQuery}. The global ZodValidationPipe only validates
 * `@Body()` DTOs, so raw `@Query` strings are otherwise unchecked: a garbage `categoryId` /
 * `locationId` / `assetId` / `applicationId` would simply match nothing and return a silently-empty
 * list, hiding a client bug. `undefined` passes through (filter absent), a well-formed cuid is
 * returned, anything else is a clean 400 (SEC-004; ADR-0005 — most domain entities use cuid).
 */
export function parseCuidQuery(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!cuidSchema.safeParse(value).success) {
    throw new BadRequestException(`Invalid ${name}: expected a cuid`);
  }
  return value;
}
