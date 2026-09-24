import { Injectable, Logger } from '@nestjs/common';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAuthScopeParamSchema,
  OAuthScopeSchema,
  formatOAuthScopes,
  type OAuthGrantRevokeReason,
  type OAuthScope,
} from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';
import {
  PrincipalLoaderService,
  type PrincipalLoadFailure,
} from '../auth/principal-loader.service';
import type { HumanPrincipal } from '../auth/principal';
import { PrismaService } from '../prisma/prisma.service';
import { isClientAllowed, redirectHost } from './client-policy';
import { isCanonicalResource } from './oauth-config';
import {
  hashOpaqueToken,
  mintOpaqueToken,
  safeEqual,
  verifyPkceS256,
} from './oauth-crypto';
import { OAuthProtocolError } from './oauth-errors';
import { OAuthAuditService } from './oauth-audit.service';
import { OAuthPolicyService } from './oauth-policy.service';
import { OAuthSubjectService } from './oauth-subject.service';
import {
  ACCESS_TOKEN_TTL_MS,
  GRANT_LAST_USED_THROTTLE_MS,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
} from './oauth.constants';

/** The RFC 6749 §5.1 success body. No `id_token`, ever (INV-AI-13). */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Request context for the audit trail. */
export interface OAuthRequestContext {
  ip?: string | null;
}

/** Why an access token was refused, and the HTTP status the resource server answers with. */
export type AccessTokenFailureReason =
  | 'malformed'
  | 'unavailable'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'wrong_audience'
  | PrincipalLoadFailure
  | 'password_change_required'
  | 'mcp_disabled'
  | 'forbidden';

/** A verified `/mcp` caller (W3-2 builds `AuthInfo` and the invocation context from it). */
export interface VerifiedAccessToken {
  ok: true;
  principal: HumanPrincipal;
  grant: {
    id: string;
    clientId: string | null;
    clientName: string | null;
    /** The granted scopes, in catalog order. */
    scopes: OAuthScope[];
  };
  /** The audience the token is bound to — always this instance's canonical `/mcp` URI. */
  resource: string;
  expiresAt: Date;
}

export type AccessTokenVerification =
  | VerifiedAccessToken
  | { ok: false; reason: AccessTokenFailureReason; status: 401 | 403 };

const invalidGrant = (description?: string) =>
  new OAuthProtocolError('invalid_grant', description);

/** Keep only the catalog scopes of a stored `text[]` (read-tolerant of a value a newer build wrote). */
function storedScopes(values: readonly string[]): OAuthScope[] {
  return values.flatMap((value) => {
    const parsed = OAuthScopeSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Tokens of the authorization server (ADR-0097 decision 8; mcp-and-oauth.md §5.2; INV-AI-9):
 *   - the `authorization_code` grant (single use, PKCE S256, exact redirect, RFC 8707 audience) which
 *     creates the grant — the "connected app";
 *   - the `refresh_token` grant, rotated on every use with reuse detection that revokes the grant;
 *   - revocation (RFC 7009 and the connected-apps UI);
 *   - {@link verifyAccessToken}, the resource-server check `/mcp` runs on every request (W3-2).
 *
 * Tokens are opaque (`lzit_oat_` / `lzit_ort_` + 256 random bits) and only their SHA-256 is stored; the
 * cleartext exists in exactly one response and is never logged. A grant snapshots the user's
 * `sessionEpoch`, so a password change, "sign out everywhere", an admin reset or a deactivation kills
 * every token it owns.
 */
@Injectable()
export class OAuthTokenService {
  private readonly logger = new Logger(OAuthTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: OAuthPolicyService,
    private readonly subjects: OAuthSubjectService,
    private readonly principals: PrincipalLoaderService,
    private readonly audit: OAuthAuditService,
  ) {}

  /* ── authorization_code ─────────────────────────────────────────────────────────────────────── */

  async exchangeAuthorizationCode(
    params: Record<string, string>,
    ctx: OAuthRequestContext = {},
  ): Promise<OAuthTokenResponse> {
    const { config, settings } = await this.policy.requireEnabled();
    const { code, redirect_uri, client_id, code_verifier, resource } = params;
    if (!code || !client_id || !redirect_uri) {
      throw new OAuthProtocolError(
        'invalid_request',
        'code, client_id and redirect_uri are required',
      );
    }
    if (!code_verifier) {
      // PKCE downgrade: a code issued with a challenge is never redeemed without its verifier.
      throw new OAuthProtocolError(
        'invalid_request',
        'code_verifier is required',
      );
    }

    const row = await this.prisma.oAuthAuthorizationCode.findUnique({
      where: { codeHash: hashOpaqueToken(code) },
      include: { client: true },
    });
    if (!row) throw invalidGrant();

    // SINGLE USE, atomically, BEFORE any other check: a code presented with a wrong verifier or client is
    // compromised and must not stay redeemable. Two concurrent redemptions: exactly one wins the update.
    const now = new Date();
    const consumed = await this.prisma.oAuthAuthorizationCode.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw invalidGrant();

    if (row.client.clientId !== client_id) throw invalidGrant();
    // EXACT match against the redirect the code was issued for — no normalization at all.
    if (row.redirectUri !== redirect_uri) throw invalidGrant();
    if (!verifyPkceS256(code_verifier, row.codeChallenge)) throw invalidGrant();
    if (
      resource !== undefined &&
      !(
        isCanonicalResource(resource, config) &&
        row.resource === config.resource
      )
    ) {
      throw new OAuthProtocolError(
        'invalid_target',
        'The resource is not this server',
      );
    }
    if (row.resource !== config.resource) throw invalidGrant();
    if (!isClientAllowed(row.client, settings)) {
      throw new OAuthProtocolError('unauthorized_client');
    }

    const user = await this.subjects.loadEligible(row.userId);
    if (!user) throw invalidGrant();

    const scopes = storedScopes(row.scopes);
    const access = mintOpaqueToken(OAUTH_ACCESS_TOKEN_PREFIX);
    const refresh = mintOpaqueToken(OAUTH_REFRESH_TOKEN_PREFIX);

    await this.prisma.$transaction(async (tx) => {
      const grant = await tx.oAuthGrant.create({
        data: {
          userId: user.id,
          kind: 'oauth',
          clientRefId: row.clientRefId,
          scopes,
          resource: config.resource,
          sessionEpoch: user.sessionEpoch,
          lastUsedAt: now,
        },
      });
      await tx.oAuthToken.createMany({
        data: [
          {
            grantId: grant.id,
            kind: 'access',
            tokenHash: access.hash,
            expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
          },
          {
            grantId: grant.id,
            kind: 'refresh',
            tokenHash: refresh.hash,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
          },
        ],
      });
      await tx.oAuthClient.update({
        where: { id: row.clientRefId },
        data: { lastUsedAt: now },
      });
      await this.audit.record(
        {
          action: 'GRANT_CREATED',
          userId: user.id,
          actorId: user.id,
          grantId: grant.id,
          clientId: row.client.clientId,
          ip: ctx.ip,
          detail: {
            scopes,
            redirectHost: redirectHost(row.redirectUri),
            clientName: row.client.name,
          },
        },
        tx,
      );
    });

    return this.tokenResponse(access.value, refresh.value, scopes);
  }

  /* ── refresh_token ──────────────────────────────────────────────────────────────────────────── */

  async refresh(
    params: Record<string, string>,
    ctx: OAuthRequestContext = {},
  ): Promise<OAuthTokenResponse> {
    const { config, settings } = await this.policy.requireEnabled();
    const { refresh_token, client_id, scope, resource } = params;
    if (!refresh_token || !client_id) {
      throw new OAuthProtocolError(
        'invalid_request',
        'refresh_token and client_id are required',
      );
    }
    if (!refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
      throw invalidGrant();
    }
    const presentedHash = hashOpaqueToken(refresh_token);
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: presentedHash },
      include: { grant: { include: { client: true } } },
    });
    if (
      !row ||
      row.kind !== 'refresh' ||
      !safeEqual(row.tokenHash, presentedHash)
    ) {
      throw invalidGrant();
    }
    const { grant } = row;
    if (
      grant.deletedAt !== null ||
      grant.kind !== 'oauth' ||
      !grant.client ||
      grant.client.clientId !== client_id
    ) {
      throw invalidGrant();
    }

    const now = new Date();
    if (row.usedAt !== null) {
      // A rotated token presented again. Inside the grace window it is a concurrent-refresh race;
      // outside it, someone else holds a copy — revoke the whole grant (the token family).
      if (now.getTime() - row.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
        await this.revokeGrant(grant.id, 'refresh_reuse', null, {
          reuseDetected: true,
          clientId: grant.client.clientId,
          userId: grant.userId,
          ip: ctx.ip,
        });
      }
      throw invalidGrant();
    }
    if (row.expiresAt.getTime() <= now.getTime()) throw invalidGrant();

    if (resource !== undefined && !isCanonicalResource(resource, config)) {
      throw new OAuthProtocolError(
        'invalid_target',
        'The resource is not this server',
      );
    }
    if (grant.resource !== config.resource) throw invalidGrant();

    // A refresh never WIDENS the grant (RFC 6749 §6). Tokens carry no scope of their own — the grant
    // does — and RFC 6749 §6 requires the rotated refresh token to keep the presented one's scope, so a
    // narrower request is refused as well: the client re-authorizes to change its scope.
    const scopes = storedScopes(grant.scopes);
    if (scope !== undefined) {
      const requested = OAuthScopeParamSchema.safeParse(scope);
      if (!requested.success) {
        throw new OAuthProtocolError('invalid_scope');
      }
      if (requested.data.some((value) => !scopes.includes(value))) {
        throw new OAuthProtocolError(
          'invalid_scope',
          'A refresh may not widen the granted scope',
        );
      }
      if (requested.data.length !== scopes.length) {
        throw new OAuthProtocolError(
          'invalid_scope',
          'Narrowing the scope on refresh is not supported; authorize again with the narrower scope',
        );
      }
    }

    if (!isClientAllowed(grant.client, settings)) {
      throw new OAuthProtocolError('unauthorized_client');
    }
    const user = await this.subjects.loadEligible(grant.userId);
    if (!user || user.sessionEpoch !== grant.sessionEpoch) {
      throw invalidGrant();
    }

    // Atomic rotation: only one presentation of this refresh token can mark it used.
    const rotated = await this.prisma.oAuthToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (rotated.count !== 1) throw invalidGrant();

    const access = mintOpaqueToken(OAUTH_ACCESS_TOKEN_PREFIX);
    const refresh = mintOpaqueToken(OAUTH_REFRESH_TOKEN_PREFIX);
    await this.prisma.$transaction(async (tx) => {
      await tx.oAuthToken.createMany({
        data: [
          {
            grantId: grant.id,
            kind: 'access',
            tokenHash: access.hash,
            expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
          },
          {
            grantId: grant.id,
            kind: 'refresh',
            tokenHash: refresh.hash,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
          },
        ],
      });
      await tx.oAuthGrant.update({
        where: { id: grant.id },
        data: { lastUsedAt: now },
      });
    });
    return this.tokenResponse(access.value, refresh.value, scopes);
  }

  /* ── revocation ─────────────────────────────────────────────────────────────────────────────── */

  /**
   * RFC 7009: revoke the grant behind an access or refresh token. Always "succeeds" from the caller's
   * view — an unknown token, another client's token or an already-revoked grant are silently ignored
   * (§2.2), so the endpoint is no token oracle. Revoking either token kills the whole grant, which is
   * what a client means by "disconnect".
   */
  async revokeByToken(
    params: Record<string, string>,
    ctx: OAuthRequestContext = {},
  ): Promise<void> {
    await this.policy.requireEnabled();
    const { token, client_id } = params;
    if (!token) {
      throw new OAuthProtocolError('invalid_request', 'token is required');
    }
    if (
      !token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) &&
      !token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)
    ) {
      return;
    }
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { grant: { include: { client: true } } },
    });
    if (!row || row.grant.kind !== 'oauth' || row.grant.deletedAt !== null) {
      return;
    }
    if (client_id !== undefined && row.grant.client?.clientId !== client_id) {
      return;
    }
    await this.revokeGrant(row.grant.id, 'revocation_endpoint', null, {
      clientId: row.grant.client?.clientId ?? null,
      userId: row.grant.userId,
      ip: ctx.ip,
    });
  }

  /**
   * Revoke a grant: soft-delete it (soft delete = revoked, ADR-0006) with its reason, hard-delete its
   * credential rows, and audit — atomically. Idempotent: returns false when it was already revoked.
   */
  async revokeGrant(
    grantId: string,
    reason: OAuthGrantRevokeReason,
    actorId: string | null,
    audit: {
      clientId?: string | null;
      userId?: string | null;
      ip?: string | null;
      reuseDetected?: boolean;
      personal?: boolean;
    } = {},
  ): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.oAuthGrant.updateMany({
        where: { id: grantId, deletedAt: null },
        data: { deletedAt: now, revokeReason: reason, revokedById: actorId },
      });
      if (revoked.count === 0) return false;
      await tx.oAuthToken.deleteMany({ where: { grantId } });
      const base = {
        userId: audit.userId ?? null,
        actorId,
        grantId,
        clientId: audit.clientId ?? null,
        ip: audit.ip ?? null,
      };
      if (audit.reuseDetected) {
        await this.audit.record(
          { ...base, action: 'REFRESH_REUSE_DETECTED', detail: { reason } },
          tx,
        );
      }
      await this.audit.record(
        {
          ...base,
          action: audit.personal ? 'PERSONAL_TOKEN_REVOKED' : 'GRANT_REVOKED',
          detail: { reason },
        },
        tx,
      );
      return true;
    });
  }

  /* ── resource-server verification (for `/mcp`, W3-2) ────────────────────────────────────────── */

  /**
   * Verify an OAuth access token presented at `/mcp` — DB-first, on every request (INV-AI-9):
   * token hash → access row (unexpired) → grant (live, OAuth kind, audience = this instance's canonical
   * `/mcp` URI) → user re-loaded (live, active, not directory-only, `sessionEpoch` equal to the grant's
   * snapshot, no forced password change) → MCP switch → `ai:connect` held NOW.
   *
   * Failures carry the HTTP status the resource server should answer: 401 for anything wrong with the
   * token or its subject (the client re-authorizes), 403 when a valid token meets a withdrawn capability
   * (MCP switched off, `ai:connect` revoked). Only `lzit_oat_` tokens are handled here; personal tokens
   * (`lan`, W3-4) and service-account tokens have their own verifiers.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenVerification> {
    const fail = (
      reason: AccessTokenFailureReason,
      status: 401 | 403 = 401,
    ): AccessTokenVerification => ({ ok: false, reason, status });

    if (!token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return fail('malformed');
    const config = this.policy.config();
    if (!config) return fail('unavailable');

    const presentedHash = hashOpaqueToken(token);
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: presentedHash },
      include: { grant: { include: { client: true } } },
    });
    if (
      !row ||
      row.kind !== 'access' ||
      !safeEqual(row.tokenHash, presentedHash)
    ) {
      return fail('invalid');
    }
    if (row.expiresAt.getTime() <= Date.now()) return fail('expired');
    const { grant } = row;
    if (grant.deletedAt !== null) return fail('revoked');
    if (grant.kind !== 'oauth') return fail('invalid');
    if (grant.resource !== config.resource) return fail('wrong_audience');

    const loaded = await this.principals.loadHuman(
      grant.userId,
      grant.sessionEpoch,
    );
    if (!loaded.ok) return fail(loaded.reason);
    const { user } = loaded.principal;
    if (user.mustChangePassword) return fail('password_change_required');

    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) return fail('mcp_disabled', 403);
    if (!(await this.subjects.holdsConnect(user))) {
      return fail('forbidden', 403);
    }

    this.stampLastUsed(grant.id, grant.lastUsedAt);
    return {
      ok: true,
      principal: loaded.principal,
      grant: {
        id: grant.id,
        clientId: grant.client?.clientId ?? null,
        clientName: grant.client?.name ?? null,
        scopes: storedScopes(grant.scopes),
      },
      resource: config.resource,
      expiresAt: row.expiresAt,
    };
  }

  /* ── helpers ────────────────────────────────────────────────────────────────────────────────── */

  private tokenResponse(
    accessToken: string,
    refreshToken: string,
    scopes: OAuthScope[],
  ): OAuthTokenResponse {
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: formatOAuthScopes(scopes),
    };
  }

  /** Fire-and-forget, throttled `lastUsedAt` stamp (the service-account precedent). */
  private stampLastUsed(grantId: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (
      lastUsedAt !== null &&
      now - lastUsedAt.getTime() < GRANT_LAST_USED_THROTTLE_MS
    ) {
      return;
    }
    const data: Prisma.OAuthGrantUpdateManyMutationInput = {
      lastUsedAt: new Date(now),
    };
    this.prisma.oAuthGrant
      .updateMany({ where: { id: grantId, deletedAt: null }, data })
      .catch((err: unknown) => {
        this.logger.warn(
          `Could not stamp lastUsedAt on OAuth grant ${grantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
