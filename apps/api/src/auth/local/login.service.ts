import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { LoginResponse } from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalCredentialService } from './local-credential.service';

/**
 * Per-account brute-force backoff (ADR-0086 §3, decision E). NOT a hard lockout (a hard lock on a known
 * admin is DoS-able); instead an EXPONENTIAL delay after a threshold of failures. Keyed by User.id, so
 * ONLY a known account can ever be locked — an attacker probing unknown identifiers can never trigger it,
 * which keeps it from being an enumeration oracle (the per-IP rate-limit handles spray from one host).
 */
const FAILURE_THRESHOLD = 5; // no delay for the first N failures (fat-finger tolerance)
const BASE_DELAY_MS = 1000; // first delay after the threshold
const MAX_DELAY_MS = 15 * 60 * 1000; // cap: 15 minutes
/** A fully cooled-down entry (unlocked this long) is reset/pruned, self-healing the map + the counter. */
const RESET_AFTER_MS = 60 * 60 * 1000; // 1 hour
/** Hard bound on the map size (defense against a flood of distinct attacked accounts). */
const MAX_TRACKED = 10_000;

interface AttemptRecord {
  count: number;
  /** Epoch-ms until which the account is backed off; 0 = not currently locked. */
  lockedUntil: number;
}

/**
 * LoginService — the `POST /auth/login` flow for AUTH_MODE=local (ADR-0086 §3). Owns the security-critical
 * login sequence: live-filtered lookup by email OR username, constant-time / no-enumeration verify (via
 * LocalCredentialService's dummy-hash path), the fail-closed state gates (directoryOnly / inactive /
 * soft-deleted), rehash-on-login, session mint, and per-account backoff.
 *
 * PER-REPLICA CAVEAT: the backoff map is in-memory (per-instance), same posture as the rate-limit guards.
 * Accepted for the single-org / few-replica target; the argon2 cost + per-IP cap are the primary defenses.
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: LocalCredentialService,
  ) {}

  /**
   * Authenticate an `identifier` (email OR username) + password. Returns the session token + safe user on
   * success; throws the SAME generic 401 for EVERY failure mode (unknown user, wrong password, null hash,
   * directory-only, inactive, soft-deleted, backed-off) so nothing distinguishes them (no oracle).
   */
  async login(identifier: string, password: string): Promise<LoginResponse> {
    const invalid = () => new UnauthorizedException('Invalid credentials');

    // Normalize for lookup: email is citext (case-insensitive) and username is stored lowercased, so a
    // single trimmed-lowercased value matches either. NEVER look up on an empty string (would risk
    // matching a null/blank column); short-circuit to the constant-time no-user path.
    const normalized = identifier.trim().toLowerCase();
    const user =
      normalized.length === 0
        ? null
        : await this.prisma.user.findFirst({
            where: {
              OR: [{ email: normalized }, { username: normalized }],
            },
          });
    // Soft-deleted rows are already excluded by the live-filtered client, so `user` is null for them too.

    // Per-account backoff: if a KNOWN account is currently backed off, still burn a verify (uniform
    // timing) and fail with the SAME generic 401 — a 429 here would reveal the account exists + is locked.
    if (user && this.isLocked(user.id)) {
      await this.credentials.verify(null, password);
      throw invalid();
    }

    // Constant-time verify. For no-user OR a null/empty passwordHash we pass `null`, which makes the
    // service verify against its dummy hash (uniform timing) and FAIL CLOSED. So an unknown user, a
    // directory-only/OIDC user (passwordHash null), and a wrong password are indistinguishable in timing.
    const result = await this.credentials.verify(
      user?.passwordHash ?? null,
      password,
    );

    // Verify FIRST, then the state gates — so `inactive`/`directoryOnly` are not a faster path than a
    // wrong password (both pay one argon2 cost). All roads lead to the same generic 401.
    const ok = Boolean(
      user && result.valid && user.isActive && !user.directoryOnly,
    );
    if (!ok) {
      if (user) {
        this.recordFailure(user.id);
      }
      throw invalid();
    }

    // Success: clear the backoff for this account.
    this.clearFailures(user!.id);

    // Rehash-on-login: transparently upgrade a below-target stored hash. Best-effort — a write failure
    // NEVER blocks a valid login (the current hash still authenticates next time).
    if (result.needsRehash) {
      try {
        const rehashed = await this.credentials.hash(password);
        await this.prisma.user.update({
          where: { id: user!.id },
          data: { passwordHash: rehashed },
        });
      } catch (err) {
        this.logger.warn(
          `rehash-on-login failed for user ${user!.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const token = await this.credentials.mintSession({
      id: user!.id,
      sessionEpoch: user!.sessionEpoch,
    });

    return {
      token,
      user: {
        id: user!.id,
        email: user!.email,
        firstName: user!.firstName,
        lastName: user!.lastName,
        username: user!.username ?? null,
        role: user!.role,
      },
    };
  }

  // ---------- per-account backoff (in-memory, per-replica) ------------------

  private isLocked(userId: string): boolean {
    const rec = this.attempts.get(userId);
    if (!rec || rec.lockedUntil === 0) {
      return false;
    }
    return Date.now() < rec.lockedUntil;
  }

  private recordFailure(userId: string): void {
    const now = Date.now();
    let rec = this.attempts.get(userId);
    // Reset a fully cooled-down account so a long-idle user starts fresh (self-healing).
    if (
      rec &&
      rec.lockedUntil !== 0 &&
      now - rec.lockedUntil > RESET_AFTER_MS
    ) {
      rec = undefined;
    }
    if (!rec) {
      rec = { count: 0, lockedUntil: 0 };
    }
    rec.count += 1;
    if (rec.count > FAILURE_THRESHOLD) {
      const over = rec.count - FAILURE_THRESHOLD; // 1, 2, 3, …
      const delay = Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS);
      rec.lockedUntil = now + delay;
    }
    this.attempts.set(userId, rec);
    this.prune(now);
  }

  private clearFailures(userId: string): void {
    this.attempts.delete(userId);
  }

  /** Drop cooled-down entries; if still over the hard bound, evict any unlocked entries. */
  private prune(now: number): void {
    if (this.attempts.size <= MAX_TRACKED) {
      // Cheap targeted prune of clearly-cooled entries only.
      for (const [id, rec] of this.attempts) {
        if (rec.lockedUntil !== 0 && now - rec.lockedUntil > RESET_AFTER_MS) {
          this.attempts.delete(id);
        }
      }
      return;
    }
    // Over the bound: evict everything not currently locked to reclaim space.
    for (const [id, rec] of this.attempts) {
      if (rec.lockedUntil === 0 || now >= rec.lockedUntil) {
        this.attempts.delete(id);
      }
    }
  }
}
