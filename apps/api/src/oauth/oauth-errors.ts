import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An OAuth protocol error response (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 7009 §2.2.1): the body is exactly
 * `{ error, error_description? }`. The global filter (BaseExceptionFilter) writes an HttpException's
 * object response verbatim, so throwing this yields a spec-shaped body with no lazyit envelope.
 */
export class OAuthProtocolError extends HttpException {
  constructor(
    readonly error: string,
    description?: string,
    status: number = HttpStatus.BAD_REQUEST,
  ) {
    super(
      description === undefined
        ? { error }
        : { error, error_description: description },
      status,
    );
  }
}

/**
 * An authorization-request error the consent page must deliver to the CLIENT by redirecting the browser
 * (RFC 6749 §4.1.2.1): only raised once the client and its redirect URI have been validated. The body
 * is `{ error, redirectTo }`; `redirectTo` already carries `error`, `state` and `iss`.
 */
export class OAuthRedirectError extends HttpException {
  constructor(
    readonly error: string,
    readonly redirectTo: string,
  ) {
    super({ error, redirectTo }, HttpStatus.BAD_REQUEST);
  }
}

/**
 * Read an `application/x-www-form-urlencoded` (or JSON) OAuth request body into single string values.
 * A parameter sent twice (the body parser yields an array) or as a nested object is a protocol error
 * (RFC 6749 §3.1: "Request and response parameters MUST NOT be included more than once").
 */
export function readProtocolParams(body: unknown): Record<string, string> {
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new OAuthProtocolError('invalid_request', 'Malformed request body');
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new OAuthProtocolError(
        'invalid_request',
        `Parameter "${key}" must be a single string value`,
      );
    }
    if (value.length > 4096) {
      throw new OAuthProtocolError(
        'invalid_request',
        `Parameter "${key}" is too long`,
      );
    }
    params[key] = value;
  }
  return params;
}
