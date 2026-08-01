import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { type Principal, isServicePrincipal } from '../auth/principal';
import { parseEnvInt } from '../common/parse-env-int';

/**
 * InfraNodeEnrollmentLimiter — bounds how many NEW topology nodes one reporter may ENROLL per time
 * window (#1134). The second half of the availability fix in ADR-0074 §8, paired with
 * {@link InfraReportRateLimitGuard}: the guard bounds how often a reporter may CALL the endpoint,
 * this bounds how many of those calls may GROW the table.
 *
 * A RATE, NOT A STOCK. The obvious design — "refuse once this reporter already owns N live PENDING
 * proposals" — was tried and rejected, because it measures the wrong thing. #1134 is about unbounded
 * GROWTH; a stock cap instead punishes ACCUMULATION, which is mostly the signature of an operator
 * with an untriaged review tray, not of an attacker. It also fails in a way a rate cap cannot: the
 * only remedy it offers the operator is to triage or delete rows, and on an instance that upgrades
 * with a large existing tray that remedy is required before the next genuinely-new host can enroll.
 * Bounding the rate has no such failure mode — pre-existing rows are simply irrelevant to it, and a
 * throttled reporter recovers by WAITING, with no operator action at all.
 *
 * IN-MEMORY, so it needs no column, no FK, no index and no migration. That is the point: attributing
 * rows to a reporter in the SCHEMA would buy per-reporter isolation that does not exist today anyway
 * — `install.sh` writes the SAME operator token on every host, so one service account already fronts
 * the whole estate and "per service account" is already "per estate". Real isolation arrives with the
 * enrollment-token → per-host-credential exchange (#1146); the key here is ready for it.
 *
 * NOT A HARD CEILING — stated plainly rather than overclaimed. It is a THROTTLE:
 *   - the check and the charge are not transactional with the row insert, so concurrent reports can
 *     each pass a check taken at the same instant and overshoot the window's budget by the number of
 *     requests in flight;
 *   - the bucket is per-process, so behind N replicas the effective allowance is N× the configured
 *     rate;
 *   - the window is FIXED, not sliding, so a reporter that spends its budget at the very end of one
 *     window and again at the start of the next enrolls up to 2× the rate in quick succession.
 * None of that weakens what it is for: turning UNBOUNDED growth into bounded growth, so a leaked
 * token or a misconfigured `OnUnitActiveSec=1s` can no longer fill the table.
 */

/**
 * New nodes one reporter may enroll per window. Coherent BY CONSTRUCTION with
 * {@link INFRA_REPORT_MAX_PER_WINDOW_DEFAULT}: both defaults assume the SAME reference estate of
 * **100 hosts sharing one operator token**, which is the shape `install.sh` actually produces. The
 * rate limit's 120 reports/min absorbs all 100 of them checking in within one minute (a site-wide
 * reboot re-arming every `Persistent=true` timer at once); this 100 enrollments/hour lets that same
 * estate enroll COMPLETELY inside a single window, so a greenfield rollout is never refused by
 * either limit. Past that, growth is capped at ~2,400 new rows/day instead of the ~172,800/day the
 * rate limit alone would still permit. A larger estate raises
 * `INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW` once, for one window, and never needs it again — steady
 * state enrolls nothing.
 */
export const INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW_DEFAULT = 100;
/**
 * One hour. Deliberately much longer than the rate limiter's minute: a per-minute enrollment cap
 * would be redundant with the guard (which already bounds calls/min), whereas the growth this must
 * bound is measured over hours and days.
 */
export const INFRA_REPORT_NEW_NODE_WINDOW_MS_DEFAULT = 60 * 60 * 1000;

interface Bucket {
  count: number;
  /** Epoch-ms when the current window started; reset once `now - windowStart > windowMs`. */
  windowStart: number;
}

@Injectable()
export class InfraNodeEnrollmentLimiter {
  private readonly logger = new Logger(InfraNodeEnrollmentLimiter.name);
  private readonly buckets = new Map<string, Bucket>();

  // Read once at construction, exactly like the sibling guard: the window length cannot change
  // mid-flight without silently reinterpreting buckets already in the map, and pinning both knobs
  // together keeps "how do I change this?" a single answer (edit the env, restart the API).
  private readonly maxPerWindow = parseEnvInt(
    'INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW',
    INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW_DEFAULT,
  );
  private readonly windowMs = parseEnvInt(
    'INFRA_REPORT_NEW_NODE_WINDOW_MS',
    INFRA_REPORT_NEW_NODE_WINDOW_MS_DEFAULT,
  );

  /**
   * Charge ONE new-node enrollment against this reporter's window, or throw 429 when the window is
   * spent. Checks and charges in a single step, and is called immediately BEFORE the insert — so a
   * create that then loses the P2002 dedup race has still spent its slot. That over-charges by one
   * per race (a rare, self-limiting event) and is the conservative direction for a limiter: it can
   * cost a reporter a slot it did not use, never grant one it did not have.
   *
   * 429, matching the guard's status, so an agent — and an operator reading the log — sees one
   * consistent "you are over a limit, back off" signal rather than two unrelated failure modes.
   */
  assertWithinBudget(principal?: Principal): void {
    const key = this.reporterKey(principal);
    const now = Date.now();

    // Opportunistic prune so the map cannot grow unbounded across many reporters.
    this.prune(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return;
    }

    if (bucket.count >= this.maxPerWindow) {
      this.logger.warn(
        `infra report refused: ${key} has enrolled ${bucket.count} new node(s) this window (max ${this.maxPerWindow}). Known hosts keep reporting normally.`,
      );
      throw new HttpException(
        'Too many newly discovered hosts in a short time. Already-known hosts keep reporting normally; new ones resume next window, or raise INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
  }

  /**
   * The budget key: the authenticated SERVICE ACCOUNT id when there is one (`sa:<id>`), the human's
   * user id when a human role holds `infra:report` (`user:<id>`), else one shared `unattributed`
   * bucket — never an exemption. The principal is resolved SERVER-side by `JwtAuthGuard`; it is
   * never taken from `reportingSource`, which is a client-chosen body field an attacker rotates per
   * request. The prefixes keep the key spaces disjoint so ids cannot collide across kinds.
   */
  private reporterKey(principal?: Principal): string {
    if (isServicePrincipal(principal)) {
      return `sa:${principal.serviceAccount.id}`;
    }
    if (principal?.kind === 'human') {
      return `user:${principal.user.id}`;
    }
    return 'unattributed';
  }

  /** Drop windows that have fully elapsed so the map stays bounded. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
