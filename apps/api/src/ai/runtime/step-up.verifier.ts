import { Injectable } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import { LocalCredentialService } from '../../auth/local/local-credential.service';
import {
  AI_STEP_UP_BASE_DELAY_MS,
  AI_STEP_UP_FAILURE_THRESHOLD,
  AI_STEP_UP_MAX_DELAY_MS,
  AI_STEP_UP_RESET_AFTER_MS,
} from './runtime.constants';

export type StepUpResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSec: number }
  | { ok: false; reason: 'unavailable' };

interface AttemptRecord {
  count: number;
  lockedUntil: number;
}

const MAX_TRACKED = 10_000;

/**
 * The password STEP-UP for elevated approvals (ADR-0097 decision 4; security.md §6.2; tools §9 "Boundary":
 * the runtime verifies it before calling core's `approve(…, { stepUpVerified: true })`).
 *
 * The password is checked by the local-auth verifier itself — `LocalCredentialService.verify` (argon2id,
 * constant-time, fail-closed on a missing hash, oversized input refused before the KDF) — against the
 * user's CURRENT stored hash. It is never stored, logged, or passed on.
 *
 * Brute force: at most ONE verification in flight per user (a concurrent attempt is answered `locked`
 * without reaching the KDF), and every attempt is counted as a failure before the KDF runs (cleared by a
 * success) — then the `LoginService` per-account policy (ADR-0086 §3), mirrored here because that service's
 * backoff map is private to the login flow: no delay for the first {@link AI_STEP_UP_FAILURE_THRESHOLD}
 * failures, then an exponential lock from 1 s up to 15 min, keyed by the user id, cleared by a success.
 * In-memory and per-process, like the login backoff. The caller is already authenticated, so a lock
 * answers `locked` openly (no enumeration concern).
 *
 * Outside `AUTH_MODE=local` there is no lazyit password to confirm: step-up is `unavailable` and the
 * action cannot be approved (fail closed).
 */
@Injectable()
export class AiStepUpVerifier {
  private readonly attempts = new Map<string, AttemptRecord>();
  /** Users with a verification running now (at most one per user). */
  private readonly inFlight = new Set<string>();
  /** The clock (tests move it). */
  now: () => number = Date.now;

  constructor(private readonly credentials: LocalCredentialService) {}

  async verify(user: User, password: string): Promise<StepUpResult> {
    if (process.env.AUTH_MODE !== 'local') {
      return { ok: false, reason: 'unavailable' };
    }
    const locked = this.lockedFor(user.id);
    if (locked > 0) {
      return { ok: false, reason: 'locked', retryAfterSec: locked };
    }
    // One verification in flight per user: a burst of concurrent attempts would otherwise all pass the
    // lock check above before any of them recorded a failure (N concurrent guesses for one).
    if (this.inFlight.has(user.id)) {
      return { ok: false, reason: 'locked', retryAfterSec: 1 };
    }
    this.inFlight.add(user.id);
    // The attempt counts as a failure BEFORE the KDF runs; a correct password clears it afterwards.
    this.recordFailure(user.id);
    try {
      const result = await this.credentials.verify(user.passwordHash, password);
      if (!result.valid) {
        return { ok: false, reason: 'invalid' };
      }
      this.attempts.delete(user.id);
      return { ok: true };
    } finally {
      this.inFlight.delete(user.id);
    }
  }

  /** Seconds the account is still locked for (0 = not locked). */
  private lockedFor(userId: string): number {
    const record = this.attempts.get(userId);
    if (!record || record.lockedUntil === 0) return 0;
    const remaining = record.lockedUntil - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  private recordFailure(userId: string): void {
    const now = this.now();
    let record = this.attempts.get(userId);
    if (
      record &&
      record.lockedUntil !== 0 &&
      now - record.lockedUntil > AI_STEP_UP_RESET_AFTER_MS
    ) {
      record = undefined;
    }
    record ??= { count: 0, lockedUntil: 0 };
    record.count += 1;
    if (record.count > AI_STEP_UP_FAILURE_THRESHOLD) {
      const over = record.count - AI_STEP_UP_FAILURE_THRESHOLD;
      record.lockedUntil =
        now +
        Math.min(
          AI_STEP_UP_BASE_DELAY_MS * 2 ** (over - 1),
          AI_STEP_UP_MAX_DELAY_MS,
        );
    }
    this.attempts.set(userId, record);
    if (this.attempts.size > MAX_TRACKED) {
      for (const [id, entry] of this.attempts) {
        if (entry.lockedUntil === 0 || now >= entry.lockedUntil) {
          this.attempts.delete(id);
        }
      }
    }
  }
}
