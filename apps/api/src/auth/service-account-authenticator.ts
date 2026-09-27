import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  isServiceAccountToken,
  parseToken,
  verifySecret,
} from '../service-accounts/service-account-token';
import type { ServicePrincipal } from './principal';
import { PrincipalLoaderService } from './principal-loader.service';

/**
 * Service-account bearer verification (ADR-0048), extracted from `JwtAuthGuard` so the guard and the
 * MCP resource server (`/mcp`, R10) share one implementation. DB-FIRST (INV-1): everything is verified
 * against the DB row, never a token claim.
 *   1. Parse `lzit_sa_<id>_<secret>`; a malformed token → 401.
 *   2. Look the ServiceAccount up BY ID, INCLUDING soft-deleted rows, so a revoked account is detected
 *      and refused rather than missed.
 *   3. Constant-time compare SHA-256(secret) to the row's `tokenHash` BEFORE any state check, so a caller
 *      without the secret cannot tell "wrong secret" from "revoked". An unknown id 401s without a compare.
 *   4. Refuse a revoked, inactive or expired account and resolve its direct grants — the shared
 *      {@link PrincipalLoaderService.serviceAccountPrincipal}.
 *   5. Stamp `lastUsedAt` best-effort (fire-and-forget; never blocks or fails the request).
 *
 * Every refusal is the same generic 401 ("Invalid service-account token"): it never reveals which check
 * failed, so there is no account-enumeration oracle.
 */
@Injectable()
export class ServiceAccountAuthenticator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalLoaderService,
  ) {}

  /** Whether a bearer value is a service-account token at all (by prefix). */
  isServiceAccountToken(bearer: string): boolean {
    return isServiceAccountToken(bearer);
  }

  /** Verify a `lzit_sa_` bearer and return its principal, or throw the generic 401. */
  async authenticate(bearer: string): Promise<ServicePrincipal> {
    const invalid = () =>
      new UnauthorizedException('Invalid service-account token');

    const parsed = parseToken(bearer);
    if (!parsed) {
      throw invalid();
    }

    const account = await this.principals.findServiceAccountIncludingRevoked(
      parsed.serviceAccountId,
    );
    if (!account) {
      throw invalid();
    }

    if (!verifySecret(parsed.secret, account.tokenHash)) {
      throw invalid();
    }

    const loaded = await this.principals.serviceAccountPrincipal(account);
    if (!loaded.ok) {
      throw invalid();
    }

    void this.prisma.serviceAccount
      .update({ where: { id: account.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return loaded.principal;
  }
}
