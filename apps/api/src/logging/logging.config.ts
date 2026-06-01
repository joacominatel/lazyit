import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

// Structured logging configuration for nestjs-pino (ADR-0031). Kept as a pure factory so it can be
// unit-tested without bootstrapping Nest. Category vocabulary (read at a glance, mapped onto Pino's
// standard levels): trace/debug -> DEBUG, info -> INFO, warn -> WARNING, error/fatal -> CRITICAL.

const REQUEST_ID_HEADER = 'x-request-id';
const RESPONSE_ID_HEADER = 'X-Request-Id';
const ACTOR_HEADER = 'x-user-id';

/** Honor an inbound X-Request-Id (else generate one) and echo it on the response for client-side
 *  correlation. nestjs-pino stamps the returned id on every log line of the request. */
function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : randomUUID();
  res.setHeader(RESPONSE_ID_HEADER, id);
  return id;
}

/**
 * Surface the authenticated actor as a clean `actor` field (the raw `x-user-id` header is redacted).
 *
 * `customProps` runs when the request log line is written — at response time, AFTER JwtAuthGuard has
 * resolved the caller and stamped `request.user` (in BOTH modes: OIDC validates the Bearer token and
 * JIT-provisions the User; shim resolves the X-User-Id header to a User). So the canonical source is
 * `request.user.id` — it works under OIDC, where there is no `x-user-id` header at all (the old
 * header-only read made every prod log line `actor:null` — the regression this fixes; ADR-0038).
 *
 * The pino-http types declare `req` as a bare `IncomingMessage`, but at runtime nestjs-pino passes
 * the same Express request the guard augmented, so we narrow to read `.user`. The `x-user-id` header
 * is kept only as a fallback for the rare case the field is read before/without the guard.
 */
function resolveActor(req: IncomingMessage): { actor: string | null } {
  const user = (req as IncomingMessage & { user?: { id?: unknown } }).user;
  if (user && typeof user.id === 'string') {
    return { actor: user.id };
  }
  const header = req.headers[ACTOR_HEADER];
  return { actor: typeof header === 'string' ? header : null };
}

/** Map a response to the category vocabulary: >=500 / error -> CRITICAL, >=400 -> WARNING, else INFO. */
function resolveLevel(
  _req: IncomingMessage,
  res: ServerResponse,
  err?: Error,
): 'error' | 'warn' | 'info' {
  if (res.statusCode >= 500 || err) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

/**
 * Build the nestjs-pino params. Pretty, human-readable output in dev; structured JSON in
 * production (detected via NODE_ENV — the prod container sets it, ADR-0028). Logs metadata only
 * (method/url/status/latency/request-id/actor) — never request/response bodies — and redacts
 * sensitive headers.
 */
export function buildLoggerParams(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Params {
  const isProduction = nodeEnv === 'production';
  return {
    pinoHttp: {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:standard',
              singleLine: true,
              ignore: 'pid,hostname',
            },
          },
      genReqId: resolveRequestId,
      customProps: resolveActor,
      customLogLevel: resolveLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-user-id"]',
        ],
        censor: '[redacted]',
      },
    },
  };
}
