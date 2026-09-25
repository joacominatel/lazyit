import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DCR_UNUSED_CLIENT_TTL_MS,
  OAUTH_SWEEP_INTERVAL_MS,
} from './oauth.constants';

/** What one pass removed. */
export interface OAuthSweepResult {
  codes: number;
  tokens: number;
  clients: number;
}

/**
 * Collects the authorization server's PROTOCOL STATE — credential rows and throwaway registrations, not
 * domain data (the `PasswordResetToken` precedent, mcp-and-oauth.md §6), so they are hard-deleted:
 *   - authorization codes that expired or were used;
 *   - tokens past their expiry (a rotated refresh token is KEPT until then — it is what reuse detection
 *     recognizes);
 *   - DCR clients never used (no code exchanged) and older than 24 h, with no grant row at all — and, on
 *     the same terms, CIMD / bundled client rows (`cimd`, `known`): they are a cache of a document the
 *     client publishes, re-fetched on the next authorization request (W3-3). A cache row is aged by its
 *     last REFRESH (`updatedAt`), not its creation, and no client row with a pending authorization code
 *     is ever collected, so a sign-in in progress never loses its client (the code would cascade).
 * Grants are never touched here: revoked grants stay soft-deleted for the record.
 *
 * The `NotificationsRetentionSweeper` shape: a plain unref'd `setInterval`, not started under
 * `NODE_ENV=test`, re-entrancy guarded, and a failing pass never crashes the app.
 */
@Injectable()
export class OAuthSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OAuthSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, OAUTH_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(now: Date = new Date()): Promise<OAuthSweepResult> {
    const empty = { codes: 0, tokens: 0, clients: 0 };
    if (this.running) return empty;
    this.running = true;
    try {
      const codes = await this.prisma.oAuthAuthorizationCode.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
      });
      const tokens = await this.prisma.oAuthToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      const cutoff = new Date(now.getTime() - DCR_UNUSED_CLIENT_TTL_MS);
      const clients = await this.prisma.oAuthClient.deleteMany({
        where: {
          lastUsedAt: null,
          grants: { none: {} },
          codes: { none: {} },
          OR: [
            { kind: 'dcr', createdAt: { lt: cutoff } },
            { kind: { in: ['cimd', 'known'] }, updatedAt: { lt: cutoff } },
          ],
        },
      });
      const result = {
        codes: codes.count,
        tokens: tokens.count,
        clients: clients.count,
      };
      if (result.codes + result.tokens + result.clients > 0) {
        this.logger.log(
          `OAuth sweep removed ${result.codes} code(s), ${result.tokens} token(s), ${result.clients} unused client(s).`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error(
        `OAuth sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    } finally {
      this.running = false;
    }
  }
}
