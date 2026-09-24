import { Injectable, Logger } from '@nestjs/common';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  PERSONAL_TOKEN_PREFIX,
} from '@lazyit/shared';
import { hashOpaqueToken, safeEqual } from '../oauth/oauth-crypto';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isServiceAccountToken,
  parseToken,
} from '../service-accounts/service-account-token';

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
 */
@Injectable()
export class McpExposedTokenService {
  private readonly logger = new Logger(McpExposedTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: OAuthTokenService,
  ) {}

  /** Handle every credential-shaped value among `values`. Returns how many grants it revoked. */
  async handle(values: readonly string[], ip?: string | null): Promise<number> {
    let revoked = 0;
    for (const value of new Set(values)) {
      try {
        if (await this.handleOne(value, ip ?? null)) revoked += 1;
      } catch (err) {
        this.logger.error(
          `Could not act on a credential exposed in a /mcp query string: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return revoked;
  }

  private async handleOne(value: string, ip: string | null): Promise<boolean> {
    if (isServiceAccountToken(value)) {
      const parsed = parseToken(value);
      this.logger.warn({
        event: 'mcp.token_in_query',
        kind: 'service_account',
        serviceAccountId: parsed?.serviceAccountId ?? null,
        action: 'rotate this Service Account token',
      });
      return false;
    }
    if (
      !value.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) &&
      !value.startsWith(OAUTH_REFRESH_TOKEN_PREFIX) &&
      !value.startsWith(PERSONAL_TOKEN_PREFIX)
    ) {
      return false;
    }
    const hash = hashOpaqueToken(value);
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hash },
      include: { grant: { include: { client: true } } },
    });
    if (!row?.grant || !safeEqual(row.tokenHash, hash)) return false;
    const { grant } = row;
    const personal = grant.kind === 'personal';
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
    if (done) {
      this.logger.warn({
        event: 'mcp.token_in_query',
        kind: personal ? 'personal' : 'oauth',
        grantId: grant.id,
        action: 'revoked',
      });
    }
    return done;
  }
}
