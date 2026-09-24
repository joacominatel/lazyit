import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

// Structured logging configuration for nestjs-pino (ADR-0031). Kept as a pure factory so it can be
// unit-tested without bootstrapping Nest. Category vocabulary (read at a glance, mapped onto Pino's
// standard levels): trace/debug -> DEBUG, info -> INFO, warn -> WARNING, error/fatal -> CRITICAL.

const REQUEST_ID_HEADER = 'x-request-id';
const RESPONSE_ID_HEADER = 'X-Request-Id';
const ACTOR_HEADER = 'x-user-id';

/** Request-body fields of the OAuth endpoints that carry a credential, redacted wherever logged. */
export const OAUTH_BODY_REDACT_PATHS = [
  'req.body.code',
  'req.body.code_verifier',
  'req.body.refresh_token',
  'req.body.access_token',
  'req.body.token',
  'req.body.password',
] as const;

/**
 * Query parameters that may carry a bearer credential. lazyit never accepts a token in a URL — `/mcp`
 * refuses it (400) and revokes it on sight — but a client that sends one must not get it written to the
 * request log (ADR-0097, #1315 G3 review F1): the parsed `req.query` is redacted and the logged URL is
 * scrubbed.
 */
export const QUERY_CREDENTIAL_PARAMS = ['access_token', 'token'] as const;

/** `url` with the value of every {@link QUERY_CREDENTIAL_PARAMS} parameter replaced by `[redacted]`. */
export function scrubUrlCredentials(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hashAt = url.indexOf('#', q);
  const end = hashAt === -1 ? url.length : hashAt;
  const query = url
    .slice(q + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // A malformed escape: compare the raw key.
      }
      return (QUERY_CREDENTIAL_PARAMS as readonly string[]).includes(
        key.toLowerCase(),
      )
        ? `${rawKey}=[redacted]`
        : pair;
    })
    .join('&');
  return `${url.slice(0, q + 1)}${query}${url.slice(end)}`;
}

/** The request serializer's last step: scrub credentials from the URL pino-http records. */
function scrubRequest<T extends { url?: unknown }>(req: T): T {
  if (typeof req.url === 'string') req.url = scrubUrlCredentials(req.url);
  return req;
}

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
      // pino-http wraps this around its standard request serializer, so it receives the serialized
      // request (method, url, query, headers…) and only rewrites its URL.
      serializers: { req: scrubRequest },
      customProps: resolveActor,
      customLogLevel: resolveLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-user-id"]',
          // OAuth credential material (ADR-0097, INV-AI-9). pino-http's request serializer never logs
          // bodies, so these are defense in depth for any log line that carries `req.body` — the
          // `/oauth/token` form (code, code_verifier, refresh_token), `/oauth/revoke` (token) and the
          // consent decision's step-up password.
          ...OAUTH_BODY_REDACT_PATHS,
          // A credential sent in a query string (refused, and revoked, by `/mcp`).
          ...QUERY_CREDENTIAL_PARAMS.map((param) => `req.query.${param}`),
        ],
        censor: '[redacted]',
      },
    },
  };
}
