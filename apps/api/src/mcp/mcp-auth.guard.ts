import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  PERSONAL_TOKEN_PREFIX,
  type AiToolClass,
} from '@lazyit/shared';
import type { Request, Response } from 'express';
import type { User } from '../../generated/prisma/client';
import {
  AI_REFUSED_SA_PERMISSION,
  AiRunPrincipals,
} from '../ai/runtime/principal-context';
import { ServiceAccountAuthenticator } from '../auth/service-account-authenticator';
import type { OAuthServerConfig } from '../oauth/oauth-config';
import { OAuthPolicyService } from '../oauth/oauth-policy.service';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { PersonalTokensService } from '../oauth/personal-tokens/personal-tokens.service';
import { QUERY_CREDENTIAL_PARAMS } from '../logging/logging.config';
import { McpConnectionNoticeService } from './mcp-connection-notice.service';
import { McpExposedTokenService } from './mcp-exposed-token.service';
import { scopesToCeiling, toAuthInfo, type McpCaller } from './mcp-caller';
import { McpRateLimiter } from './mcp-rate-limit';

/** The request once this guard has let it through. */
export type McpRequest = Request & {
  auth?: ReturnType<typeof toAuthInfo>;
  mcpCaller?: McpCaller;
  user?: User;
};

/** The scopes a client should ask for, advertised in the 401 challenge (RFC 6750 §3). */
const CHALLENGE_SCOPE = 'lazyit.read lazyit.write';

/** A refusal that answers with an RFC 6750 challenge. `description` is always a fixed, quote-free string. */
class McpAuthRefusal extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly error: 'invalid_token' | 'access_denied',
    readonly description: string,
  ) {
    super(description);
  }
}

const TOKEN_REFUSED = 'The access token is invalid, expired or revoked.';

/**
 * The `/mcp` authentication gate (ADR-0097 decisions 9 and 12; mcp-and-oauth.md §5.1, §5.3, §5.4, §7;
 * security.md §6.3; INV-AI-9). The MCP route is `@Public()` towards the global session guards — this
 * guard is its ONLY way in, and the controller fails closed without what it sets. In order:
 *
 *  1. **The capability exists.** In the shim (AI is never available there) or while the instance's MCP
 *     switch is off, `/mcp` answers **404** to everyone, before anything else is read: off by default
 *     means no new anonymous surface (INV-AI-12).
 *  2. **Transport.** A present `Origin` whose host is not this instance's is refused (403, the spec's
 *     DNS-rebinding MUST); with a pinned origin (`WEB_ORIGIN`) the `Host` must name it too. A token in
 *     the query string is refused (400) — tokens travel only in the `Authorization` header — and, being
 *     compromised, is revoked on sight before anything else ({@link McpExposedTokenService}; G3 F1),
 *     within a bound: charged to the per-IP refused-authentication limiter, at most a few well-formed
 *     values, one query (SEC-083).
 *  3. **The bearer**, by prefix — and nothing else. A local session JWT, an IdP token or any other value
 *     is refused (no token passthrough):
 *     - `lzit_oat_` — only on an HTTPS instance (the pinned issuer); {@link OAuthTokenService.verifyAccessToken}.
 *     - `lzit_pat_` — only on an instance WITHOUT OAuth (`lan`); {@link PersonalTokensService.verify}.
 *     - `lzit_sa_`  — a Service Account holding `ai:connect` (R10, fail-closed), not holding
 *       `infra:report` (ADR-0097 default 16), whose per-SA AI access is not `off` (`read-only` caps it at
 *       read tools). The SEC-073 strip of SA-ungrantable grants applies (it is the shared authenticator).
 *     Every human check is DB-first on every request: user live, active, not directory-only, no forced
 *     password change, `mcpCredentialEpoch` equal to the grant's snapshot (a web logout does not move it:
 *     ADR-0097 decision 8, amended 2026-09-24), `ai:connect` held now.
 *  4. **Answers.** A missing or refused token → **401** with the RFC 6750 challenge: on an HTTPS
 *     instance `Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="…"` (RFC
 *     9728 discovery); on `lan` a plain `Bearer realm="lazyit"` (no authorization server to discover). A
 *     valid token whose capability was withdrawn (`ai:connect`, the SA's AI access) → **403**. Refused
 *     authentications are rate-limited per client IP (429).
 *
 * On success it sets `req.auth` (the SDK's `AuthInfo`, carrying the verified {@link McpCaller} — never
 * the bearer), `req.mcpCaller`, and `req.user` for a human (request-log attribution only); counts the
 * caller's request rate (429 past it); and announces a connection's first use to its owner
 * ({@link McpConnectionNoticeService}).
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly policy: OAuthPolicyService,
    private readonly oauthTokens: OAuthTokenService,
    private readonly personalTokens: PersonalTokensService,
    private readonly serviceAccounts: ServiceAccountAuthenticator,
    private readonly runPrincipals: AiRunPrincipals,
    private readonly rateLimiter: McpRateLimiter,
    private readonly notices: McpConnectionNoticeService,
    private readonly exposed: McpExposedTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<McpRequest>();
    const res = http.getResponse<Response>();

    // 0 — a credential in the URL is compromised whatever happens next: revoke it on sight (G3 F1). This
    //     runs for anyone, even while MCP is off, so it is bounded (SEC-083): the request is charged to the
    //     per-IP refused-authentication limiter first (no DB, so the off-by-default surface stays inert), an
    //     address over it gets no scan at all, and the scan itself reads at most a few well-formed values in
    //     one query. The answer (404 / 400) never changes.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const queryTokens = queryTokensOf(req);
    if (queryTokens.length > 0 && this.rateLimiter.authFailure(ip)) {
      await this.exposed.handle(queryTokens, ip);
    }

    // 1 — the capability exists at all.
    if (process.env.AUTH_MODE === 'shim') throw new NotFoundException();
    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) throw new NotFoundException();

    // 2 — transport.
    this.checkOriginAndHost(req);
    if (queryTokens.length > 0) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description:
            'Send the token in the Authorization header, never in the URL.',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const config = this.policy.config();
    if (this.rateLimiter.authBlocked(ip)) throw tooManyRequests();

    // 3 — the bearer.
    const bearer = extractBearer(req);
    if (!bearer) {
      // The normal discovery probe of an OAuth client: not counted as a refusal.
      this.challenge(res, config, null);
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description: config
            ? 'Authorization required. Connect this client with its sign-in flow.'
            : 'Authorization required. Send a personal MCP token as a Bearer token.',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    let verified: { caller: McpCaller; expiresAt?: Date; user?: User };
    try {
      verified = await this.verify(bearer, config);
    } catch (err) {
      if (!(err instanceof McpAuthRefusal)) throw err;
      if (!this.rateLimiter.authFailure(ip)) throw tooManyRequests();
      if (err.status === 401) this.challenge(res, config, err);
      throw new HttpException(
        {
          error: err.error,
          error_description: err.description,
        },
        err.status,
      );
    }

    const { caller, expiresAt, user } = verified;
    if (!this.rateLimiter.request(caller.rateKey)) throw tooManyRequests();
    req.auth = toAuthInfo(caller, expiresAt);
    req.mcpCaller = caller;
    if (user) req.user = user;
    if (caller.kind !== 'service') this.notices.noticeFirstUse(caller);
    return true;
  }

  /* ── verification by token kind ─────────────────────────────────────────────────────────────── */

  private async verify(
    bearer: string,
    config: OAuthServerConfig | null,
  ): Promise<{ caller: McpCaller; expiresAt?: Date; user?: User }> {
    if (bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      if (!config) {
        throw new McpAuthRefusal(
          401,
          'invalid_token',
          'This instance does not use OAuth for AI agents: use a personal MCP token.',
        );
      }
      const result = await this.oauthTokens.verifyAccessToken(bearer);
      if (!result.ok) throw refusalFor(result.status, result.reason);
      const { user } = result.principal;
      // The delegated identity carries the LIVE `sessionEpoch` just re-read: the tool calls of THIS request
      // re-load the user at it, while the credential itself is bound to `mcpCredentialEpoch` (checked above),
      // so a web logout never kills the connection — at most a tool call already in flight at that instant.
      return {
        caller: {
          kind: 'oauth',
          identity: {
            kind: 'human',
            userId: user.id,
            sessionEpoch: user.sessionEpoch,
          },
          grant: result.grant,
          ceiling: scopesToCeiling(result.grant.scopes),
          rateKey: `grant:${result.grant.id}`,
        },
        expiresAt: result.expiresAt,
        user,
      };
    }

    if (bearer.startsWith(PERSONAL_TOKEN_PREFIX)) {
      const result = await this.personalTokens.verify(bearer);
      if (!result.ok) {
        if (result.reason === 'unavailable') {
          throw new McpAuthRefusal(
            401,
            'invalid_token',
            'This instance uses OAuth for AI agents: personal tokens are not accepted. Connect the client with its sign-in flow.',
          );
        }
        throw refusalFor(result.status, result.reason);
      }
      const { user } = result.principal;
      return {
        caller: {
          kind: 'personal',
          identity: {
            kind: 'human',
            userId: user.id,
            sessionEpoch: user.sessionEpoch,
          },
          grant: {
            id: result.grant.id,
            clientId: null,
            clientName: result.grant.clientName,
            scopes: result.grant.scopes,
          },
          ceiling: scopesToCeiling(result.grant.scopes),
          rateKey: `grant:${result.grant.id}`,
        },
        expiresAt: result.expiresAt,
        user,
      };
    }

    if (this.serviceAccounts.isServiceAccountToken(bearer)) {
      let principal;
      try {
        principal = await this.serviceAccounts.authenticate(bearer);
      } catch {
        throw new McpAuthRefusal(401, 'invalid_token', TOKEN_REFUSED);
      }
      const { serviceAccount, permissions } = principal;
      if (!permissions.has('ai:connect')) {
        throw new McpAuthRefusal(
          403,
          'access_denied',
          'This Service Account does not hold ai:connect.',
        );
      }
      if (permissions.has(AI_REFUSED_SA_PERMISSION)) {
        throw new McpAuthRefusal(
          403,
          'access_denied',
          'A Service Account holding infra:report cannot use AI agents.',
        );
      }
      const access = await this.runPrincipals.serviceAccountSettings(
        serviceAccount.id,
      );
      if (access.access === 'off') {
        throw new McpAuthRefusal(
          403,
          'access_denied',
          'AI access is turned off for this Service Account.',
        );
      }
      const ceiling: AiToolClass[] =
        access.access === 'read-only'
          ? ['read']
          : ['read', 'write', 'elevated'];
      return {
        caller: {
          kind: 'service',
          identity: { kind: 'service', serviceAccountId: serviceAccount.id },
          ceiling,
          rateKey: `sa:${serviceAccount.id}`,
          maxWritesPerHour: access.maxMutationsPerRun,
        },
        ...(serviceAccount.expiresAt
          ? { expiresAt: serviceAccount.expiresAt }
          : {}),
      };
    }

    // A session JWT, an IdP token, a refresh token, anything else: never accepted here.
    throw new McpAuthRefusal(401, 'invalid_token', TOKEN_REFUSED);
  }

  /* ── transport and challenge ────────────────────────────────────────────────────────────────── */

  /**
   * A present `Origin` must name this instance's host (port-agnostic, the SDK's rule; the literal `null`
   * origin is refused). The reference is the pinned public origin when there is one, else — on a `lan`
   * instance, reachable at any host — the request's own `Host`. With a pinned origin the `Host` must name
   * it too (DNS rebinding). Native clients send no `Origin` and pass.
   */
  private checkOriginAndHost(req: Request): void {
    const pinned = pinnedHostname();
    if (pinned) {
      const host = validateHostHeader(req.headers.host, [pinned]);
      if (!host.ok) throw forbiddenTransport('The Host header is not allowed.');
    }
    const origin = req.headers.origin;
    if (origin === undefined || origin === '') return;
    const reference = pinned ?? hostnameOf(req.headers.host);
    if (!reference) throw forbiddenTransport('The Origin is not allowed.');
    const result = validateOriginHeader(origin, [reference]);
    if (!result.ok) throw forbiddenTransport('The Origin is not allowed.');
  }

  /**
   * RFC 6750 §3 / RFC 9728 §5.1. On an HTTPS instance the challenge points at the protected-resource
   * metadata so the client discovers the authorization server; on `lan` there is none to discover.
   */
  private challenge(
    res: Response,
    config: OAuthServerConfig | null,
    refusal: McpAuthRefusal | null,
  ): void {
    const params: string[] = [];
    if (config) {
      params.push(
        `resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`,
        `scope="${CHALLENGE_SCOPE}"`,
      );
    } else {
      params.push('realm="lazyit"');
    }
    if (refusal) {
      params.push(
        `error="${refusal.error}"`,
        `error_description="${refusal.description}"`,
      );
    }
    res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  }
}

/** The bearer value of an `Authorization: Bearer …` header (scheme case-insensitive), or null. */
function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** Every value of an `access_token` / `token` query parameter (case-insensitive name). */
function queryTokensOf(req: Request): string[] {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const values: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (
      !(QUERY_CREDENTIAL_PARAMS as readonly string[]).includes(
        key.toLowerCase(),
      )
    ) {
      continue;
    }
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) values.push(typeof item === 'string' ? item : '');
  }
  return values;
}

/** The hostname a `Host` header names (brackets kept for IPv6), or null when it is absent or unparsable. */
function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname || null;
  } catch {
    return null;
  }
}

/** The hostname of the pinned public origin (`WEB_ORIGIN`), or null on a `lan` instance. */
function pinnedHostname(): string | null {
  const raw = process.env.WEB_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}

/** Map a verifier's refusal to the answer. 401 for anything about the token or its user; 403 otherwise. */
function refusalFor(status: 401 | 403, reason: string): McpAuthRefusal {
  if (status === 403) {
    return new McpAuthRefusal(
      403,
      'access_denied',
      reason === 'mcp_disabled'
        ? 'External AI agents are turned off on this instance.'
        : 'Your account no longer holds ai:connect.',
    );
  }
  return new McpAuthRefusal(
    401,
    'invalid_token',
    reason === 'password_change_required'
      ? 'Your password must be changed before an AI agent can act for you.'
      : TOKEN_REFUSED,
  );
}

function forbiddenTransport(description: string): HttpException {
  return new HttpException(
    { error: 'forbidden', error_description: description },
    HttpStatus.FORBIDDEN,
  );
}

function tooManyRequests(): HttpException {
  return new HttpException(
    {
      error: 'rate_limited',
      error_description: 'Too many requests. Wait a moment and try again.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
