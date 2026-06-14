import { Injectable, Logger } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { NotificationsService } from './notifications.service';

/**
 * VaultSetupNudgeService — the login-time vault-setup nudge (ADR-0056 amendment 2026-06-14, issue #453).
 *
 * Condition (ADR-0061 §7 / INV-10): a user who HOLDS `secret:read` but has NO `UserKeypair` (they have
 * never set a vault passphrase, so they cannot decrypt any vault) gets a ONE-TIME TARGETED notification
 * — `recipientUserId = that user`, type `secret.vault_setup`, copy "set up your vault passphrase",
 * deep-linking to `/secrets`.
 *
 * IDEMPOTENT — fires EXACTLY ONCE per user, ever. The dedupe key is the STABLE `secret.vault_setup:<id>`
 * (no time bucket): because `Notification.dedupeKey` is `@unique`, the emit collapses to the existing
 * row on every subsequent login, so a user who logs in ten times before setting up their vault gets
 * exactly one nudge — and none after they create their `UserKeypair` (the condition no longer holds, so
 * the emit is never even attempted again).
 *
 * FAIL-SOFT — {@link notifyIfVaultSetupNeeded} NEVER throws to its caller. It is wired at the post-login
 * seam (`GET /users/me`, the app-load self-read), and a notification problem must NEVER block login or
 * the `/me` response. Any error (a permission-resolve miss, a DB hiccup, an emit failure) is logged and
 * swallowed; the underlying `NotificationsService.emit` is itself best-effort and idempotent.
 *
 * INV-10 — this nudge carries NO secret value and NO key material: only the non-secret metadata "you
 * have not set up your vault" + a link. The server already knows whether a `UserKeypair` row exists
 * (that is non-secret metadata, ADR-0061 §9); it never decrypts anything. apps/api stays crypto-free.
 */
@Injectable()
export class VaultSetupNudgeService {
  private readonly logger = new Logger(VaultSetupNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The stable, one-time dedupe key — one vault-setup nudge per user, ever. */
  private dedupeKey(userId: string): string {
    return `secret.vault_setup:${userId}`;
  }

  /**
   * Emit the one-time vault-setup nudge IF the user holds `secret:read` but has no `UserKeypair`. Called
   * fail-soft at the post-login seam. Returns silently on any path that should NOT nudge (no
   * `secret:read`, keypair already exists) and swallows every error (never blocks login).
   */
  async notifyIfVaultSetupNeeded(user: User): Promise<void> {
    try {
      // (1) Does the caller's role hold `secret:read`? (DB-first via the resolver, INV-1 / INV-8.)
      const canReadSecrets = await this.permissions.hasAll(user.role, [
        'secret:read',
      ]);
      if (!canReadSecrets) {
        return;
      }

      // (2) Do they already have a keypair? If so, they have set up their vault — nothing to nudge.
      // (`UserKeypair.userId` is unique 1:1; checking existence is non-secret metadata, INV-10-safe.)
      const keypair = await this.prisma.userKeypair.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });
      if (keypair) {
        return;
      }

      // (3) Emit the TARGETED, idempotent nudge. `emit` is itself best-effort + dedupe-collapsing, so a
      // re-login is a quiet no-op. NO secret material — copy + link only (INV-10).
      await this.notifications.emit({
        type: 'secret.vault_setup',
        dedupeKey: this.dedupeKey(user.id),
        severity: 'info',
        recipientUserId: user.id,
        title: 'Set up your vault passphrase',
        summary:
          'You have access to the Secret Manager but have not set up a vault passphrase yet. Set it up to read and store secrets.',
        // No closed entityType maps to /secrets; the bell deep-links by TYPE (`secret.vault_setup`)
        // to /secrets on the web side. No key material is carried (INV-10).
      });
    } catch (err) {
      // FAIL-SOFT: a notification problem must never block login or the /me response.
      this.logger.error(
        `vault-setup nudge failed for user=${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
