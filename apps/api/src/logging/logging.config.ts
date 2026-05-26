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

/** Surface the X-User-Id auth shim (ADR-0022) as a clean `actor` field; the raw header is redacted. */
function resolveActor(req: IncomingMessage): { actor: string | null } {
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
