import { Injectable, Logger } from '@nestjs/common';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  PERSONAL_TOKEN_PREFIX,
} from '@lazyit/shared';
import {
  hasOpaqueTokenShape,
  hashOpaqueToken,
  safeEqual,
} from '../oauth/oauth-crypto';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isServiceAccountToken,
  parseToken,
} from '../service-accounts/service-account-token';
import { MCP_QUERY_TOKEN_SCAN_MAX } from './mcp.constants';

/** The opaque-token prefixes whose grant is revoked on sight. */
const REVOCABLE_PREFIXES = [
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  PERSONAL_TOKEN_PREFIX,
] as const;

/** Whether a query value can be a lazyit credential at all: an exact opaque-token shape, or a parsable SA token. */
function isCredentialShaped(value: string): boolean {
  if (isServiceAccountToken(value)) return parseToken(value) !== null;
  return REVOCABLE_PREFIXES.some((prefix) =>
    hasOpaqueTokenShape(value, prefix),
  );
}

/**
 * A credential seen in a URL query string at `/mcp` is COMPROMISED (#1315 G3 review F1): URLs end up in
 * proxy logs, browser history and referrers. lazyit never accepts one there — `McpAuthGuard` answers 400
 * — and this service acts on it before answering:
 *   - an OAuth access or refresh token, or a personal token → its whole grant is revoked on sight
 *     (`revokeReason: "token_exposed"`, audited like any revocation: `GRANT_REVOKED` or
 *     `PERSONAL_TOKEN_REVOKED`);
 *   - a Service Account token → a warning event naming the account (never the secret), so an admin rotates
 *     it: lazyit does not revoke a Service Account on its own, it may be a production integration.
 * Unknown values are ignored silently (no oracle). Never throws: the request is refused either way.
 *
 * Bounded (SEC-083): it runs for anonymous callers before the MCP switch is read, so its work per request
 * is capped. Only values with the exact credential grammar are candidates (prefix plus the fixed-length
 * body the minter produces), at most {@link MCP_QUERY_TOKEN_SCAN_MAX} distinct ones, looked up in ONE
 * query. The guard also charges the per-IP refused-authentication limiter before calling it.
 */
@Injectable()
export class McpExposedTokenService {
  private readonly logger = new Logger(McpExposedTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: OAuthTokenService,
  ) {}

  /** Handle the credential-shaped values among `values`. Returns how many grants it revoked. */
  async handle(values: readonly string[], ip?: string | null): Promise<number> {
    const candidates = [...new Set(values)]
      .filter(isCredentialShaped)
      .slice(0, MCP_QUERY_TOKEN_SCAN_MAX);
    const opaque: string[] = [];
    for (const value of candidates) {
      if (isServiceAccountToken(value)) this.warnServiceAccount(value);
      else opaque.push(value);
    }
    if (opaque.length === 0) return 0;
    try {
      return await this.revokeExposed(opaque, ip ?? null);
    } catch (err) {
      this.logError(err);
      return 0;
    }
  }

  private warnServiceAccount(value: string): void {
    const parsed = parseToken(value);
    this.logger.warn({
      event: 'mcp.token_in_query',
      kind: 'service_account',
      serviceAccountId: parsed?.serviceAccountId ?? null,
      action: 'rotate this Service Account token',
    });
  }

  private async revokeExposed(
    values: readonly string[],
    ip: string | null,
  ): Promise<number> {
    const hashes = values.map(hashOpaqueToken);
    const rows = await this.prisma.oAuthToken.findMany({
      where: { tokenHash: { in: hashes } },
      include: { grant: { include: { client: true } } },
    });
    const seen = new Set<string>();
    let revoked = 0;
    for (const row of rows) {
      const { grant } = row;
      if (!grant || seen.has(grant.id)) continue;
      if (!hashes.some((hash) => safeEqual(row.tokenHash, hash))) continue;
      seen.add(grant.id);
      const personal = grant.kind === 'personal';
      try {
        const done = await this.tokens.revokeGrant(
          grant.id,
          'token_exposed',
          null,
          {
            userId: grant.userId,
            clientId: grant.client?.clientId ?? null,
            ip,
            personal,
          },
        );
        if (!done) continue;
        revoked += 1;
        this.logger.warn({
          event: 'mcp.token_in_query',
          kind: personal ? 'personal' : 'oauth',
          grantId: grant.id,
          action: 'revoked',
        });
      } catch (err) {
        this.logError(err);
      }
    }
    return revoked;
  }

  private logError(err: unknown): void {
    this.logger.error(
      `Could not act on a credential exposed in a /mcp query string: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
