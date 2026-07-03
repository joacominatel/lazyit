import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { ChangePasswordResponse } from '@lazyit/shared';
import type { User } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UserHistoryService } from '../../user-history/user-history.service';
import { SmtpService } from '../../smtp/smtp.service';
import {
  buildTransport,
  formatFrom,
  renderPasswordResetEmail,
} from '../../smtp/email.mailer';
import { LocalCredentialService } from './local-credential.service';
import { hashResetToken, mintResetToken } from './password-reset-token';

/** Reset-token TTL — ≤1h per ADR-0086 §F4 / SECURITY GAP #7. */
const RESET_TTL_MINUTES = 60;
const RESET_TTL_MS = RESET_TTL_MINUTES * 60 * 1000;

/**
 * Cap on simultaneously-outstanding reset tokens per account — a per-account throttle against
 * email-bombing one user with reset links. Over the cap → the forgot flow silently skips creating another
 * token (it NEVER changes the uniform response, so it is not an enumeration oracle). Complements the
 * per-IP rate-limit guard on the endpoint.
 */
const MAX_ACTIVE_TOKENS_PER_USER = 3;

/**
 * PasswordLifecycleService — the self-service password flows for AUTH_MODE=local (ADR-0086 §F4, F4a):
 *   - {@link changePassword} — an authenticated human rotates their own password (verify current → set
 *     new → bump epoch → clear mustChangePassword).
 *   - {@link forgotPassword} — public, enumeration-safe: resolve the user, mint a hashed single-use token,
 *     email the link if SMTP is configured, and ALWAYS return the same uniform response.
 *   - {@link resetPassword} — public: consume a token (hashed lookup, single-use, TTL-checked) → set new
 *     password → bump epoch → invalidate sibling tokens.
 *
 * Security posture mirrors LoginService / LocalCredentialService: generic errors (no oracle), epoch-bump
 * revocation, INV-10 separation (this service never touches vault key material — only login credentials).
 * Every flow is gated on local mode; in OIDC/shim mode they fail closed (no tokens exist; change is N/A).
 */
@Injectable()
export class PasswordLifecycleService {
  private readonly logger = new Logger(PasswordLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LocalCredentialService,
    private readonly history: UserHistoryService,
    private readonly smtp: SmtpService,
  ) {}

  /** True when the instance runs first-party local auth (AUTH_MODE=local, ADR-0086). */
  private isLocalMode(): boolean {
    return process.env.AUTH_MODE === 'local';
  }

  // ---------- 1. self-service change-password (ADR-0086 §F4) -----------------

  /**
   * Change the caller's OWN password (authenticated human, local mode). Verifies `currentPassword`
   * against the stored hash (generic 401 on mismatch — no "which field is wrong" oracle), sets the new
   * hash, BUMPS `sessionEpoch` (revoking every OTHER session the user holds), clears `mustChangePassword`,
   * and stamps `passwordUpdatedAt`. Audits PASSWORD_CHANGED. Returns a FRESH session token minted at the
   * new epoch so the caller who just changed their password stays logged in (their old token is now dead).
   *
   * The `user` is the row the guard loaded THIS request (@CurrentUser) — already live, active and not
   * directoryOnly (handleLocal rejects those). Defensive re-checks are kept fail-closed regardless.
   */
  async changePassword(
    user: User,
    currentPassword: string,
    newPassword: string,
  ): Promise<ChangePasswordResponse> {
    if (!this.isLocalMode()) {
      // Not applicable outside local mode — OIDC users have no lazyit-owned password to change.
      throw new ForbiddenException(
        'Password change is not available in this authentication mode.',
      );
    }
    // Defensive: a directory-only person has no login credential by construction (the guard already
    // refuses one, but never authenticate/rotate a credential for one here either).
    if (user.directoryOnly) {
      throw new ForbiddenException('This account cannot change a password.');
    }

    // Verify the CURRENT password against the stored hash (constant-time / fail-closed via the credential
    // service's dummy-hash path). A null/empty stored hash never verifies → generic 401. Same 401 for a
    // wrong password: nothing distinguishes "no local password set" from "wrong password".
    const result = await this.credentials.verify(
      user.passwordHash,
      currentPassword,
    );
    if (!result.valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reject a no-op rotation: the new password must actually DIFFER from the current one. Otherwise a
    // mustChangePassword user could submit their admin-set temp password as both `current` and `new`,
    // clearing the forced-change flag WITHOUT ever rotating the credential — defeating forced rotation.
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        'New password must differ from the current password.',
      );
    }

    const newHash = await this.credentials.hash(newPassword);
    // Set the credential, bump sessionEpoch, and kill any outstanding reset tokens — ALL atomically. The
    // epoch bump revokes every existing session (the guard's handleLocal rejects any token minted at a
    // lower epoch), so a compromised session dies the moment the real owner changes their password
    // (ADR-0086 §3 revocation); the token sweep does the same for any live emailed reset link (symmetry
    // with resetPassword, which invalidates siblings), so a change also closes that vector.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          passwordUpdatedAt: new Date(),
          mustChangePassword: false,
          sessionEpoch: { increment: 1 },
        },
      });
      // Any outstanding (unused) reset token is now stale — a self-service change supersedes it. Delete
      // rather than mark used: these rows are already GC-pruned, and a hard delete leaves nothing to leak.
      await tx.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });
      // Append-only audit (self-action: actor == subject). No plaintext is ever recorded.
      await this.history.record(tx, {
        userId: user.id,
        eventType: 'PASSWORD_CHANGED',
        actor: { userId: user.id },
      });
      return row;
    });

    // Mint a fresh token at the NEW epoch so the caller stays authenticated (their prior token just died).
    const token = await this.credentials.mintSession({
      id: updated.id,
      sessionEpoch: updated.sessionEpoch,
    });
    return { token };
  }

  // ---------- 3. forgot-password (public, enumeration-safe) ------------------

  /**
   * Begin a password reset for an email-or-username `identifier` (public, local mode). ALWAYS resolves to
   * the SAME uniform outcome whether or not the account exists / an email was sent — the caller cannot
   * tell (ADR-0086 §F4 / SECURITY GAP #7). When a LIVE, active, non-directory user matches, mint a
   * single-use hashed token (SHA-256 at rest, ≤1h TTL) and, if SMTP is configured, email the reset link.
   *
   * Enumeration/timing (F-1, issue #1006): the ONLY synchronous work is the constant `findFirst` lookup
   * plus a cheap eligibility check — run identically whether or not an account matches. The variable-cost
   * token issuance (GC + per-account cap + INSERT + audit + email) is DETACHED into {@link issueResetToken}
   * (fire-and-forget, like the email already was), so it runs AFTER this method returns and never adds to
   * response latency. Result: latency is existence-independent with NO dummy/garbage work, complementing
   * the per-IP rate-limit guard + the identical response body. Nothing about the response (status, shape,
   * latency class) differs between "user exists" and "does not".
   */
  async forgotPassword(identifier: string): Promise<void> {
    // In non-local mode there are no local passwords or tokens — do nothing, but return the SAME uniform
    // outcome (the caller/controller responds identically) so the mode is not observable here either.
    if (!this.isLocalMode()) {
      return;
    }

    const normalized = identifier.trim().toLowerCase();
    const user =
      normalized.length === 0
        ? null
        : await this.prisma.user.findFirst({
            where: { OR: [{ email: normalized }, { username: normalized }] },
          });

    // Only issue a token to a login-capable account. A soft-deleted row is already invisible (live-filtered
    // client); an inactive or directory-only user is skipped silently (still the uniform outcome).
    if (!user || !user.isActive || user.directoryOnly) {
      return;
    }

    // Detach the VARIABLE-cost issuance so the response latency equals the constant `findFirst` for BOTH a
    // match and a miss (F-1). Fire-and-forget (like sendResetEmail): any error is logged + swallowed and
    // never surfaces to the caller, so the uniform outcome is preserved.
    void this.issueResetToken(user).catch((err) =>
      this.logger.warn(
        `password-reset issuance failed for user ${user.id}: ${errText(err)}`,
      ),
    );
  }

  /**
   * Mint + dispatch a reset token for a resolved, login-capable `user` — the DETACHED tail of
   * {@link forgotPassword} (F-1, issue #1006). Runs out-of-band so none of its variable-cost work (the GC
   * sweep, the per-account cap check, the INSERT, the issuance audit, the SMTP send) contributes to the
   * response latency, and it is only ever reached AFTER the eligibility check — so it never fires for a
   * non-existent / inactive / directory-only identifier. All the original cap/GC semantics are unchanged;
   * they simply moved here.
   */
  private async issueResetToken(user: User): Promise<void> {
    // Opportunistic GC: drop this user's already-used or expired tokens so the table + the per-account cap
    // stay bounded. Best-effort (a failure never blocks the flow).
    try {
      await this.prisma.passwordResetToken.deleteMany({
        where: {
          userId: user.id,
          OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
        },
      });
    } catch (err) {
      this.logger.warn(
        `password-reset token prune failed for user ${user.id}: ${errText(err)}`,
      );
    }

    // Per-account throttle: cap simultaneously-outstanding tokens. Over the cap → skip silently (uniform).
    const active = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active >= MAX_ACTIVE_TOKENS_PER_USER) {
      return;
    }

    const { raw, tokenHash } = mintResetToken();
    await this.prisma.passwordResetToken.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    // Audit the ISSUANCE (F-4, issue #1006): a reset link was actually minted for a real, login-capable
    // user. Written ONLY here — inside the detached path, AFTER a token is created — so it never affects
    // response latency and NEVER fires for a non-existent / inactive / directory-only identifier (so it is
    // not an enumeration oracle; the user_history log is admin-only, so its existence is not observable to
    // a non-admin caller either). Self-service: actor == subject. No plaintext token is ever recorded.
    await this.history.record(this.prisma, {
      userId: user.id,
      eventType: 'PASSWORD_RESET_REQUESTED',
      actor: { userId: user.id },
    });

    // Send the email out-of-band. Fail-soft: a missing config or a send error is logged and swallowed (the
    // admin-reset path remains the fallback).
    void this.sendResetEmail(user.email, raw).catch((err) =>
      this.logger.warn(
        `password-reset email dispatch failed for user ${user.id}: ${errText(err)}`,
      ),
    );
  }

  /**
   * Render + send the reset email if SMTP is configured and a WEB_ORIGIN is known (the link target).
   * FAIL-SOFT: when SMTP is off/incomplete or WEB_ORIGIN is unset, no email goes out and the flow still
   * succeeds uniformly — the operator's default is the admin-reset path (ADR-0086 §5), so a missing SMTP
   * is not an error. The raw token appears ONLY in the emailed link; it is never logged.
   */
  private async sendResetEmail(email: string, rawToken: string): Promise<void> {
    const config = await this.smtp.resolveConfig(true);
    if (!config) {
      return; // Email off or incomplete — nothing to send (not an error).
    }
    const origin = process.env.WEB_ORIGIN;
    if (!origin) {
      this.logger.warn(
        'WEB_ORIGIN is not set; cannot build a password-reset link (skipping email).',
      );
      return;
    }
    const resetUrl = `${origin.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const rendered = renderPasswordResetEmail({
      resetUrl,
      brandName: 'lazyit',
      ttlMinutes: RESET_TTL_MINUTES,
    });
    const transporter = buildTransport(config);
    await transporter.sendMail({
      from: formatFrom(config),
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  }

  // ---------- 4. reset-password (public, token) ------------------------------

  /**
   * Complete a password reset with a raw token (public, local mode). Looks the token up by its SHA-256
   * (hash-at-rest), verifies it is not expired and not used, then in ONE transaction sets the new
   * password, BUMPS `sessionEpoch`, marks the token used (single-use, race-safe), invalidates the user's
   * OTHER outstanding tokens, clears `mustChangePassword`, and audits PASSWORD_RESET_COMPLETED.
   *
   * EVERY failure — unknown token, expired, already-used, ineligible user, or non-local mode — throws the
   * SAME generic error, so there is no oracle distinguishing them.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const generic = () =>
      new BadRequestException('Invalid or expired reset token.');

    if (!this.isLocalMode()) {
      throw generic();
    }

    const tokenHash = hashResetToken(rawToken);
    const row = await this.prisma.passwordResetToken.findFirst({
      where: { tokenHash },
    });
    // Not found, already consumed, or past its TTL → the SAME generic error (no distinguishing signal).
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw generic();
    }

    // The token is bound to a user; re-load LIVE-filtered so a soft-deleted user is invisible → generic
    // error. Reject an inactive or directory-only subject too (same generic error — no oracle).
    const user = await this.prisma.user.findFirst({
      where: { id: row.userId },
    });
    if (!user || !user.isActive || user.directoryOnly) {
      throw generic();
    }

    const newHash = await this.credentials.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      // Consume THIS token FIRST, race-safe: updateMany guarded by `usedAt: null`. If a concurrent reset
      // already consumed it (count 0), roll back with the generic error — single-use is enforced even
      // under a double-submit.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw generic();
      }

      // Invalidate the user's OTHER outstanding tokens (any concurrently-issued reset links die now).
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null, id: { not: row.id } },
        data: { usedAt: new Date() },
      });

      // Set the new credential + bump the epoch (revoke all sessions) + clear the one-time flag.
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          passwordUpdatedAt: new Date(),
          mustChangePassword: false,
          sessionEpoch: { increment: 1 },
        },
      });

      // Append-only audit (self-service reset via token: actor == subject).
      await this.history.record(tx, {
        userId: user.id,
        eventType: 'PASSWORD_RESET_COMPLETED',
        actor: { userId: user.id },
      });
    });
  }
}

/** Short, non-secret error text for a log line. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
