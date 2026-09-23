import { HttpException } from '@nestjs/common';
import type { AiToolErrorCode } from '@lazyit/shared';

/** A tool-level error, ready for an `AiToolResult`. */
export interface MappedToolError {
  code: AiToolErrorCode;
  status: number;
  message: string;
}

const GENERIC_INTERNAL = 'The tool failed unexpectedly.';

function statusToCode(status: number): AiToolErrorCode {
  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'NOT_AVAILABLE';
  if (status >= 500) return 'INTERNAL';
  return 'INVALID_INPUT';
}

function httpMessage(err: HttpException): string {
  const response = err.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return err.message;
}

/**
 * The Prisma known-request codes the global `PrismaExceptionFilter` maps, with the same statuses and the
 * same generic messages (never echoing a column or a value). Matched structurally so this module does not
 * load the generated client.
 */
const PRISMA_CODES: Readonly<Record<string, MappedToolError>> = {
  P2002: {
    code: 'CONFLICT',
    status: 409,
    message: 'A record with these values already exists',
  },
  P2003: {
    code: 'INVALID_INPUT',
    status: 400,
    message: 'Invalid reference: a related record does not exist',
  },
  P2025: { code: 'NOT_FOUND', status: 404, message: 'Record not found' },
  P2023: {
    code: 'INVALID_INPUT',
    status: 400,
    message: 'Invalid input format for one or more fields',
  },
  P2020: {
    code: 'INVALID_INPUT',
    status: 400,
    message: 'A value is out of the allowed range',
  },
};

function prismaCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'PrismaClientKnownRequestError') {
    return undefined;
  }
  const code: unknown = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Map what a dispatched handler threw to a tool error (the HTTP statuses the route would have answered,
 * as tool error codes). A 5xx or an unknown error never exposes its message: it may carry internals.
 */
export function mapToolError(err: unknown): MappedToolError {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const code = statusToCode(status);
    return {
      code,
      status,
      message: code === 'INTERNAL' ? GENERIC_INTERNAL : httpMessage(err),
    };
  }
  const prisma = prismaCode(err);
  if (prisma !== undefined && PRISMA_CODES[prisma]) {
    return PRISMA_CODES[prisma];
  }
  return { code: 'INTERNAL', status: 500, message: GENERIC_INTERNAL };
}
