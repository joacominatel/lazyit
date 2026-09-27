import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * Raw path and header values of the AI HTTP surfaces, checked before they reach a query (the global
 * ZodValidationPipe validates `@Body()` DTOs only).
 */

/** A conversation or run id: a cuid. Anything else cannot name a row, so it is the same 404 as a miss. */
const ENTITY_ID = /^[a-z0-9]{20,40}$/;

export function aiEntityId(value: string): string {
  if (!ENTITY_ID.test(value)) {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
  }
  return value;
}

/**
 * The provider tool-use id of a decision (`tool.approval_required.toolCallId`): a provider id such as
 * `toolu_…` / `call_…`, or the runtime's `lz_<runId>_<step>_<index>` replacement. Printable ASCII, bounded.
 */
const TOOL_CALL_ID = /^[\x21-\x7e]{1,256}$/;

export function aiToolCallId(value: string): string {
  if (!TOOL_CALL_ID.test(value)) {
    throw new NotFoundException({
      code: 'NOT_FOUND',
      message: 'Pending action not found',
    });
  }
  return value;
}

/** An `Idempotency-Key` header: 1–255 printable ASCII characters (else 400; absent = none). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export function idempotencyKeyOf(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      message: 'Idempotency-Key must be 1-255 printable ASCII characters',
    });
  }
  return value;
}

/**
 * The interface locale for a new conversation's frozen prompt: the first tag of `Accept-Language`. The
 * prompt builder normalizes it again (an invalid tag becomes `en`); this only keeps it short.
 */
export function localeOf(
  acceptLanguage: string | undefined,
): string | undefined {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim();
  if (
    !first ||
    first.length > 35 ||
    !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(first)
  ) {
    return undefined;
  }
  return first;
}
