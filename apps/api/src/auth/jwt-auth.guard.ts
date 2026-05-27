import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '../../generated/prisma/client';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of OIDC userinfo / standard claims used for JIT provisioning. */
interface ProfileClaims {
  email?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  [key: string]: unknown;
}

/**
 * Global auth guard (ADR-0038). Two modes:
 *
 * AUTH_MODE=shim (dev/test) — reads X-User-Id header; resolves user by UUID; never 401s.
 *   Present + valid UUID → user set on request; absent → request.user = undefined (anonymous).
 *
 * OIDC mode (production default) — validates Bearer JWT against the JWKS endpoint of
 *   OIDC_ISSUER. JIT-provisions a User on first login (externalId = sub). Missing/invalid
 *   token → 401 UnauthorizedException. On the JIT path the guard enriches the profile from the
 *   standard OIDC userinfo endpoint (ADR-0038): an OAuth access token carries authorization, not
 *   identity, so email/name claims must be fetched from userinfo. The userinfo endpoint is located
 *   via OIDC Discovery (BYOI-safe; no vendor path hardcoding) and the lookup is fail-soft — any
 *   discovery/userinfo failure falls back to the token's claims, never breaking login.
 *
 * The JWKS RemoteKeySet is created once at module scope (jose caches keys internally).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  // Lazily initialized on first use so startup succeeds even when OIDC_ISSUER is unset in shim mode.
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  // Resolved once via OIDC Discovery and cached for the app lifetime (like `jwks`), so repeated
  // JIT provisions do not re-run discovery. Null = not yet resolved (or last resolution failed).
  private userinfoEndpoint: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();

    if (process.env.AUTH_MODE === 'shim') {
      return this.handleShim(request);
    }

    return this.handleOidc(request);
  }

  // ---------- shim mode -----------------------------------------------------

  private async handleShim(
    request: Request & { user?: User },
  ): Promise<boolean> {
    const rawId = (request.headers['x-user-id'] as string | undefined)?.trim();
    if (!rawId) {
      request.user = undefined;
      return true;
    }
    if (!UUID_REGEX.test(rawId)) {
      // Invalid UUID format → treat as anonymous (same as absent) to avoid breaking existing dev
      // tooling; the old ActorService threw 400 but a global guard must not 400 on a missing user.
      request.user = undefined;
      return true;
    }
    const user = await this.prisma.user.findFirst({ where: { id: rawId } });
    // Soft-deleted users are filtered by the Prisma extension, so findFirst returns null for them.
    request.user = user ?? undefined;
    return true;
  }

  // ---------- OIDC mode -----------------------------------------------------

  private async handleOidc(
    request: Request & { user?: User },
  ): Promise<boolean> {
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = authHeader.slice(7);

    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) {
      throw new UnauthorizedException(
        'OIDC_ISSUER is not configured on the server',
      );
    }

    // Lazy-init the JWKS key set (one per app lifetime; jose caches fetched keys).
    if (!this.jwks) {
      const jwksUri =
        process.env.OIDC_JWKS_URI ?? `${issuer}/.well-known/jwks.json`;
      // When JWKS is fetched from an internal Docker URL, Zitadel still resolves its instance
      // from the forwarded host. Inject X-Forwarded-* derived from the external issuer so the
      // fetch reaches the right instance (otherwise Zitadel returns 404 "Instance not found").
      const headers = this.forwardedHeaders(issuer);
      const options = headers ? { headers } : undefined;
      this.jwks = createRemoteJWKSet(new URL(jwksUri), options);
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer,
        // audience validation: omit if OIDC_CLIENT_ID is unset so the guard does not fail when
        // access tokens carry a resource audience rather than the client id.
        ...(process.env.OIDC_CLIENT_ID
          ? { audience: process.env.OIDC_CLIENT_ID }
          : {}),
      }));
    } catch {
      throw new UnauthorizedException('Invalid or expired Bearer token');
    }

    const sub = payload.sub;
    if (!sub) {
      throw new UnauthorizedException('Token is missing the sub claim');
    }

    // JIT provision: upsert the User row on first login (ADR-0038). The access token is passed
    // so the JIT path can enrich the profile from the OIDC userinfo endpoint (the token itself
    // carries authorization, not identity).
    const user = await this.jitProvision(sub, token, payload);
    request.user = user;
    return true;
  }

  /**
   * JIT provisioning (ADR-0038). If a User with `externalId = sub` already exists, return it
   * (no discovery / userinfo call). Otherwise, on the first login only, enrich the access token's
   * claims with the OIDC userinfo profile (the access token alone lacks email/name), then create
   * the User: sub → externalId, email, given_name + family_name → firstName/lastName (falls back
   * to splitting `name`, then the email local-part).
   */
  private async jitProvision(
    sub: string,
    accessToken: string,
    claims: JWTPayload,
  ): Promise<User> {
    const existing = await this.prisma.user.findFirst({
      where: { externalId: sub },
    });
    if (existing) {
      return existing;
    }

    // First login: the OIDC access token carries authorization, not identity, so fetch the real
    // profile from the userinfo endpoint and merge it OVER the token claims. Fail-soft — on any
    // failure `fetchUserinfo` returns null and we provision from the token claims alone.
    const userinfo = await this.fetchUserinfo(accessToken);
    const profile: ProfileClaims = { ...claims, ...(userinfo ?? {}) };

    const emailClaim =
      typeof profile['email'] === 'string' ? profile['email'] : undefined;
    const email = emailClaim ?? `${sub}@unknown`;

    // Name resolution: given_name + family_name → split `name` → email local-part.
    let firstName: string;
    let lastName: string;
    const givenName =
      typeof profile['given_name'] === 'string'
        ? profile['given_name']
        : undefined;
    const familyName =
      typeof profile['family_name'] === 'string'
        ? profile['family_name']
        : undefined;
    if (givenName || familyName) {
      firstName = givenName ?? '';
      lastName = familyName ?? '';
    } else {
      const fullName =
        typeof profile['name'] === 'string' ? profile['name'] : undefined;
      if (fullName) {
        const parts = fullName.trim().split(/\s+/);
        firstName = parts[0] ?? '';
        lastName = parts.slice(1).join(' ') || '';
      } else {
        // Last resort: use the email local-part as firstName, empty lastName.
        firstName = email.split('@')[0] ?? sub;
        lastName = '';
      }
    }

    return this.prisma.user.create({
      data: {
        externalId: sub,
        email,
        firstName,
        lastName,
        isActive: true,
      },
    });
  }

  /**
   * Fetch the OIDC userinfo profile for the given access token. Fail-soft: returns the parsed
   * claims object on success, or `null` on any failure (missing issuer, discovery error, non-2xx,
   * malformed JSON) after logging a warning. Login must never break because userinfo failed.
   *
   * The userinfo endpoint is located via OIDC Discovery (read once, then cached) rather than a
   * hardcoded path, keeping the guard IdP-agnostic (BYOI — ADR-0037). When OIDC_JWKS_URI is set
   * (the Docker split-DNS case), both the discovery and userinfo requests are rewritten to the
   * internal origin with X-Forwarded-* headers, exactly like the JWKS init above.
   */
  private async fetchUserinfo(
    accessToken: string,
  ): Promise<ProfileClaims | null> {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) {
      return null;
    }

    try {
      const endpoint = await this.resolveUserinfoEndpoint(issuer);
      if (!endpoint) {
        return null;
      }

      const requestUrl = this.toInternalOrigin(endpoint);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      };
      const forwarded = this.forwardedHeaders(issuer);
      if (forwarded) {
        Object.assign(headers, forwarded);
      }

      const res = await fetch(requestUrl, { headers });
      if (!res.ok) {
        this.logger.warn(
          `OIDC userinfo request returned ${res.status}; falling back to token claims for JIT provisioning`,
        );
        return null;
      }
      return (await res.json()) as ProfileClaims;
    } catch (err) {
      this.logger.warn(
        `OIDC userinfo enrichment failed (${err instanceof Error ? err.message : String(err)}); falling back to token claims for JIT provisioning`,
      );
      return null;
    }
  }

  /**
   * Resolve and cache the userinfo endpoint via OIDC Discovery
   * (`${issuer}/.well-known/openid-configuration`). Returns the discovered `userinfo_endpoint`
   * (its EXTERNAL URL as advertised by the IdP) or null if discovery fails / omits it. Cached at
   * instance scope so repeated provisions reuse the result. Throwing here is fine — the caller
   * (`fetchUserinfo`) wraps the whole flow in try/catch and treats it as fail-soft.
   */
  private async resolveUserinfoEndpoint(
    issuer: string,
  ): Promise<string | null> {
    if (this.userinfoEndpoint) {
      return this.userinfoEndpoint;
    }

    const discoveryUrl = this.toInternalOrigin(
      `${issuer}/.well-known/openid-configuration`,
    );
    const headers: Record<string, string> = { Accept: 'application/json' };
    const forwarded = this.forwardedHeaders(issuer);
    if (forwarded) {
      Object.assign(headers, forwarded);
    }

    const res = await fetch(discoveryUrl, { headers });
    if (!res.ok) {
      this.logger.warn(
        `OIDC discovery request returned ${res.status}; cannot resolve userinfo endpoint`,
      );
      return null;
    }
    const doc = (await res.json()) as { userinfo_endpoint?: unknown };
    if (typeof doc.userinfo_endpoint !== 'string') {
      this.logger.warn(
        'OIDC discovery document has no string userinfo_endpoint; skipping userinfo enrichment',
      );
      return null;
    }
    this.userinfoEndpoint = doc.userinfo_endpoint;
    return this.userinfoEndpoint;
  }

  // ---------- internal-origin / forwarded-header helpers --------------------

  /**
   * X-Forwarded-* headers derived from the EXTERNAL issuer, or undefined when no internal-origin
   * rewrite is in effect. When OIDC_JWKS_URI is set (the Docker split-DNS case), requests reach
   * the IdP at an internal URL but the IdP still resolves its instance from the forwarded host, so
   * we forward the canonical external host/proto. When OIDC_JWKS_URI is unset, returns undefined
   * (no rewrite, no forwarded headers). Shared by the JWKS init and the discovery/userinfo flow.
   */
  private forwardedHeaders(
    issuer: string,
  ): { 'X-Forwarded-Host': string; 'X-Forwarded-Proto': string } | undefined {
    if (!process.env.OIDC_JWKS_URI) {
      return undefined;
    }
    const ext = new URL(issuer);
    return {
      'X-Forwarded-Host': ext.host,
      'X-Forwarded-Proto': ext.protocol.replace(':', ''),
    };
  }

  /**
   * Rewrite an external IdP URL to the internal origin when OIDC_JWKS_URI is set (the internal
   * origin is derived from it). The path/query are preserved; only the origin (scheme + host +
   * port) changes. When OIDC_JWKS_URI is unset, the URL is returned unchanged.
   */
  private toInternalOrigin(externalUrl: string): string {
    const jwksUri = process.env.OIDC_JWKS_URI;
    if (!jwksUri) {
      return externalUrl;
    }
    const internalOrigin = new URL(jwksUri).origin;
    const url = new URL(externalUrl);
    return `${internalOrigin}${url.pathname}${url.search}`;
  }

  /** Visible for testing: reset the cached JWKS set + userinfo endpoint between tests. */
  resetJwks(): void {
    this.jwks = null;
    this.userinfoEndpoint = null;
  }
}
