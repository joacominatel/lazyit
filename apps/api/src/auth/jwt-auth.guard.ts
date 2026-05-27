import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '../../generated/prisma/client';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global auth guard (ADR-0038). Two modes:
 *
 * AUTH_MODE=shim (dev/test) — reads X-User-Id header; resolves user by UUID; never 401s.
 *   Present + valid UUID → user set on request; absent → request.user = undefined (anonymous).
 *
 * OIDC mode (production default) — validates Bearer JWT against the JWKS endpoint of
 *   OIDC_ISSUER. JIT-provisions a User on first login (externalId = sub). Missing/invalid
 *   token → 401 UnauthorizedException.
 *
 * The JWKS RemoteKeySet is created once at module scope (jose caches keys internally).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  // Lazily initialized on first use so startup succeeds even when OIDC_ISSUER is unset in shim mode.
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: User }>();

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
      const jwksUri = process.env.OIDC_JWKS_URI ?? `${issuer}/.well-known/jwks.json`;
      // When JWKS is fetched from an internal Docker URL, Zitadel still resolves its instance
      // from the forwarded host. Inject X-Forwarded-* derived from the external issuer so the
      // fetch reaches the right instance (otherwise Zitadel returns 404 "Instance not found").
      let options: Parameters<typeof createRemoteJWKSet>[1] | undefined;
      if (process.env.OIDC_JWKS_URI) {
        const ext = new URL(issuer);
        options = {
          headers: {
            'X-Forwarded-Host': ext.host,
            'X-Forwarded-Proto': ext.protocol.replace(':', ''),
          },
        };
      }
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

    // JIT provision: upsert the User row on first login (ADR-0038).
    const user = await this.jitProvision(sub, payload);
    request.user = user;
    return true;
  }

  /**
   * JIT provisioning (ADR-0038). If a User with `externalId = sub` already exists, return it.
   * Otherwise, create one from the OIDC claims: sub → externalId, email, given_name + family_name
   * → firstName/lastName (falls back to splitting `name`, then the email local-part).
   */
  private async jitProvision(sub: string, claims: JWTPayload): Promise<User> {
    const existing = await this.prisma.user.findFirst({
      where: { externalId: sub },
    });
    if (existing) {
      return existing;
    }

    const email = (claims['email'] as string | undefined) ?? `${sub}@unknown`;

    // Name resolution: given_name + family_name → split `name` → email local-part.
    let firstName: string;
    let lastName: string;
    const givenName = claims['given_name'] as string | undefined;
    const familyName = claims['family_name'] as string | undefined;
    if (givenName || familyName) {
      firstName = givenName ?? '';
      lastName = familyName ?? '';
    } else {
      const fullName = claims['name'] as string | undefined;
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

  /** Visible for testing: reset the cached JWKS set between tests. */
  resetJwks(): void {
    this.jwks = null;
  }
}
