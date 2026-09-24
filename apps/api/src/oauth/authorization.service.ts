import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import {
  OAuthAuthorizeDecisionSchema,
  OAuthAuthorizeParamsSchema,
  OAuthScopeParamSchema,
  OAUTH_SCOPES,
  type OAuthAuthorizeRedirect,
  type OAuthAuthorizeRefusal,
  type OAuthAuthorizeValidation,
  type OAuthScope,
} from '@lazyit/shared';
import type { OAuthClient, User } from '../../generated/prisma/client';
import { LocalCredentialService } from '../auth/local/local-credential.service';
import { isHumanPrincipal, type Principal } from '../auth/principal';
import { PrismaService } from '../prisma/prisma.service';
import {
  isClientAllowed,
  isLoopbackRedirect,
  isRedirectAdmitted,
  matchesRegisteredRedirect,
  redirectHost,
} from './client-policy';
import { isCanonicalResource, type OAuthServerConfig } from './oauth-config';
import { isS256Challenge, mintAuthorizationCode } from './oauth-crypto';
import { OAuthRedirectError } from './oauth-errors';
import { OAuthAuditService } from './oauth-audit.service';
import { OAuthPolicyService } from './oauth-policy.service';
import { OAuthSubjectService } from './oauth-subject.service';
import {
  AUTHORIZATION_CODE_TTL_MS,
  DEFAULT_REQUESTED_SCOPES,
} from './oauth.constants';

/** A validated authorization request, ready to show consent for or to issue a code. */
interface ValidatedRequest {
  config: OAuthServerConfig;
  user: User;
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  scopes: OAuthScope[];
  state: string | undefined;
}

type CheckResult =
  | { kind: 'refusal'; refusal: OAuthAuthorizeRefusal }
  | { kind: 'ok'; request: ValidatedRequest };

/** Why a decision was refused before any redirect — the consent page shows an error, never redirects. */
export class OAuthAuthorizeRefusedException extends HttpException {
  constructor(readonly refusal: OAuthAuthorizeRefusal) {
    super(
      { statusCode: HttpStatus.FORBIDDEN, message: refusal, refusal },
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * The authorization endpoint's server half (mcp-and-oauth.md §5.2). The consent PAGE lives on the web
 * (`/oauth/authorize`, W3-9); it forwards the raw request parameters here with the user's session Bearer:
 *   - `validate` answers what the consent screen shows, or a typed refusal;
 *   - `decision` RE-VALIDATES everything (nothing from the page is trusted), then issues a single-use
 *     code or an `access_denied` redirect.
 *
 * Order of checks (RFC 6749 §4.1.2.1): an unknown/unallowed client or an unregistered redirect NEVER
 * redirects — the page renders an error. Only once both are proven does a request error travel to the
 * client as a redirect carrying `error`, `state` and `iss` (RFC 9207).
 *
 * Consent is ALWAYS shown (nothing is remembered, R7). `lazyit.admin` is never implied by a default and
 * needs a password step-up on approval.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: OAuthPolicyService,
    private readonly subjects: OAuthSubjectService,
    private readonly credentials: LocalCredentialService,
    private readonly audit: OAuthAuditService,
  ) {}

  async validate(
    principal: Principal | undefined,
    rawParams: unknown,
  ): Promise<OAuthAuthorizeValidation> {
    const checked = await this.check(principal, rawParams);
    if (checked.kind === 'refusal') {
      return { ok: false, refusal: checked.refusal };
    }
    const { client, redirectUri, scopes, user } = checked.request;
    return {
      ok: true,
      client: {
        id: client.clientId,
        name: client.name,
        uri: client.clientUri,
        verified: client.kind !== 'dcr',
      },
      redirectUri,
      redirectHost: redirectHost(redirectUri),
      loopbackOnly: isLoopbackRedirect(redirectUri),
      scopes,
      user: { email: user.email },
    };
  }

  async decision(
    principal: Principal | undefined,
    rawBody: unknown,
    ctx: { ip?: string | null } = {},
  ): Promise<OAuthAuthorizeRedirect> {
    const parsed = OAuthAuthorizeDecisionSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException('Malformed consent decision');
    }
    const body = parsed.data;
    const checked = await this.check(principal, body.params);
    if (checked.kind === 'refusal') {
      throw new OAuthAuthorizeRefusedException(checked.refusal);
    }
    const request = checked.request;
    const { config, client, redirectUri, user, state } = request;

    if (body.decision === 'deny') {
      await this.audit.record({
        action: 'CONSENT_DENIED',
        userId: user.id,
        actorId: user.id,
        clientId: client.clientId,
        ip: ctx.ip,
        detail: { redirectHost: redirectHost(redirectUri) },
      });
      return {
        redirectTo: buildRedirect(redirectUri, {
          error: 'access_denied',
          state,
          iss: config.issuer,
        }),
      };
    }

    // The user may grant a SUBSET of what the client asked for, never more.
    const granted = OAUTH_SCOPES.filter((scope) => body.scopes.includes(scope));
    if (
      granted.length === 0 ||
      granted.some((scope) => !request.scopes.includes(scope))
    ) {
      throw new BadRequestException(
        'The granted scopes must be a non-empty subset of the requested scopes',
      );
    }
    if (granted.includes('lazyit.admin')) {
      await this.requireStepUp(user, body.password);
    }

    const code = mintAuthorizationCode();
    await this.prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: code.hash,
        userId: user.id,
        clientRefId: client.id,
        redirectUri,
        codeChallenge: request.codeChallenge,
        scopes: granted,
        resource: config.resource,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      },
    });
    return {
      redirectTo: buildRedirect(redirectUri, {
        code: code.value,
        state,
        iss: config.issuer,
      }),
    };
  }

  /**
   * `lazyit.admin` unlocks the `elevated` tools, so approving it re-proves the password (security §6.3).
   * Only a local-mode account has one; elsewhere the admin scope cannot be granted.
   */
  private async requireStepUp(
    user: User,
    password: string | undefined,
  ): Promise<void> {
    if (process.env.AUTH_MODE !== 'local' || !user.passwordHash) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Admin actions cannot be granted on this instance.',
        code: 'STEP_UP_UNAVAILABLE',
      });
    }
    if (!password) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Granting admin actions requires your password.',
        code: 'STEP_UP_REQUIRED',
      });
    }
    const result = await this.credentials.verify(user.passwordHash, password);
    if (!result.valid) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'The password is not correct.',
        code: 'STEP_UP_FAILED',
      });
    }
  }

  /** Every check of an authorization request, in the order RFC 6749 §4.1.2.1 requires. */
  private async check(
    principal: Principal | undefined,
    rawParams: unknown,
  ): Promise<CheckResult> {
    const config = this.policy.requireConfig();
    const refuse = (refusal: OAuthAuthorizeRefusal): CheckResult => ({
      kind: 'refusal',
      refusal,
    });

    // Lenient shape: every field optional here, so a missing PKCE challenge becomes a redirected
    // `invalid_request` rather than a bare 400. Lengths are still bounded by the shared schema.
    const shape = OAuthAuthorizeParamsSchema.partial().safeParse(rawParams);
    if (!shape.success) {
      throw new BadRequestException('Malformed authorization request');
    }
    const params = shape.data;

    if (!isHumanPrincipal(principal)) return refuse('FORBIDDEN');
    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) return refuse('AI_DISABLED');
    const user = principal.user;
    if (!this.subjects.isUsable(user)) return refuse('FORBIDDEN');
    if (!(await this.subjects.holdsConnect(user))) return refuse('FORBIDDEN');

    // 1. The client: known, and admitted by the instance's allowlist (never by its name).
    if (!params.client_id) return refuse('INVALID_CLIENT');
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId: params.client_id },
    });
    if (!client || !isClientAllowed(client, settings)) {
      return refuse('INVALID_CLIENT');
    }

    // 2. The redirect: registered (exact, loopback port-agnostic) and admitted by the policy.
    const redirectUri = params.redirect_uri;
    if (
      !redirectUri ||
      !matchesRegisteredRedirect(redirectUri, client.redirectUris) ||
      !isRedirectAdmitted(client, redirectUri, settings)
    ) {
      return refuse('INVALID_REDIRECT');
    }

    // From here on, errors go back to the client through its (now trusted) redirect.
    const state = params.state;
    const fail = (error: string): never => {
      throw new OAuthRedirectError(
        error,
        buildRedirect(redirectUri, { error, state, iss: config.issuer }),
      );
    };
    if (params.response_type !== 'code') fail('unsupported_response_type');
    // PKCE S256 only: `plain` and a missing challenge are refused (downgrade blocked).
    if (
      params.code_challenge_method !== 'S256' ||
      !params.code_challenge ||
      !isS256Challenge(params.code_challenge)
    ) {
      fail('invalid_request');
    }
    let scopes: OAuthScope[] = [...DEFAULT_REQUESTED_SCOPES];
    if (params.scope !== undefined) {
      const requested = OAuthScopeParamSchema.safeParse(params.scope);
      if (!requested.success) fail('invalid_scope');
      else scopes = requested.data;
    }
    // RFC 8707: absent → this server (tolerant); anything else must name the canonical `/mcp` URI.
    if (
      params.resource !== undefined &&
      !isCanonicalResource(params.resource, config)
    ) {
      fail('invalid_target');
    }

    return {
      kind: 'ok',
      request: {
        config,
        user,
        client,
        redirectUri,
        codeChallenge: params.code_challenge as string,
        scopes,
        state,
      },
    };
  }
}

/**
 * Append response parameters to a registered redirect URI, keeping its own query. Works for https,
 * loopback http and private-use schemes (`cursor://…`) alike; undefined values are skipped.
 */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
