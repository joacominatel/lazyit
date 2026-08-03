import { HttpException } from '@nestjs/common';
import type { Principal } from '../auth/principal';
import {
  InfraNodeEnrollmentLimiter,
  INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW_DEFAULT,
} from './infra-node-enrollment.limiter';

/** The reporting agent's authenticated service principal (ADR-0048) — the enrollment-budget key. */
function saPrincipal(id: string): Principal {
  return {
    kind: 'service',
    serviceAccount: { id },
    permissions: new Set(['infra:report']),
  } as unknown as Principal;
}

/** A human holding `infra:report` — a real bucket of its own, never an exemption. */
function humanPrincipal(id: string): Principal {
  return { kind: 'human', user: { id } } as unknown as Principal;
}

/** Charge one enrollment and return the thrown value (or undefined when it was allowed). */
function attempt(
  limiter: InfraNodeEnrollmentLimiter,
  principal?: Principal,
): unknown {
  try {
    limiter.assertWithinBudget(principal);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('InfraNodeEnrollmentLimiter (#1134)', () => {
  const ENV_KEYS = [
    'INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW',
    'INFRA_REPORT_NEW_NODE_WINDOW_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.useRealTimers();
  });

  it('THE HAPPY PATH: a whole 100-host estate enrolls inside ONE window with zero rejections', () => {
    // The coherence requirement. `install.sh` writes the SAME operator token on every host, so a
    // first rollout enrolls the entire estate against ONE service account. The default is sized for
    // the SAME 100-host estate the per-minute rate limit is sized for — so the two limits agree, and
    // a greenfield rollout is never refused by either of them.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-fleet');
    for (let host = 0; host < 100; host++) {
      expect(attempt(limiter, agent)).toBeUndefined();
    }
  });

  it('allows enrollments up to the cap for one reporter within a window, then 429s', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-1');
    for (let i = 0; i < INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW_DEFAULT; i++) {
      expect(attempt(limiter, agent)).toBeUndefined();
    }
    const thrown = attempt(limiter, agent);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
  });

  it('bounds GROWTH, not stock: a reporter sitting on a huge untriaged tray still enrolls freely', () => {
    // The design pivot away from the stock cap. The limiter holds NO row state at all — it cannot
    // see, and must not care, how many PENDING proposals are already waiting. An operator who has
    // let 500 proposals pile up is not an attacker, and must not be throttled like one; the next
    // window is as generous as the first.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '10';
    process.env.INFRA_REPORT_NEW_NODE_WINDOW_MS = '3600000';
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-1');
    // Five windows in a row, each one fully spent: 50 enrollments, never a rejection at a window
    // start. Accumulated stock is irrelevant — only the per-window rate is.
    for (let window = 0; window < 5; window++) {
      for (let i = 0; i < 10; i++) {
        expect(attempt(limiter, agent)).toBeUndefined();
      }
      expect(attempt(limiter, agent)).toBeInstanceOf(HttpException);
      jest.advanceTimersByTime(3_600_001);
    }
  });

  it('the window resets: a throttled reporter recovers on the next window without operator action', () => {
    // The upgrade-safety property the stock cap could not offer. Nothing has to be triaged, deleted
    // or backfilled for a refused reporter to be let back in — waiting is enough.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
    process.env.INFRA_REPORT_NEW_NODE_WINDOW_MS = '60000';
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-1');
    expect(attempt(limiter, agent)).toBeUndefined();
    expect(attempt(limiter, agent)).toBeInstanceOf(HttpException);
    jest.advanceTimersByTime(60_001);
    expect(attempt(limiter, agent)).toBeUndefined();
  });

  it('keys on the SERVICE ACCOUNT: one exhausted reporter never starves another', () => {
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '2';
    const limiter = new InfraNodeEnrollmentLimiter();
    const noisy = saPrincipal('sa-noisy');
    for (let i = 0; i < 2; i++) expect(attempt(limiter, noisy)).toBeUndefined();
    expect(attempt(limiter, noisy)).toBeInstanceOf(HttpException);

    expect(attempt(limiter, saPrincipal('sa-quiet'))).toBeUndefined();
  });

  it('a HUMAN holding infra:report gets its own bucket — never unthrottled, never the agent’s', () => {
    // `infra:report` is grantable to a human role, so a non-service caller must be budgeted too;
    // an unkeyed caller must never become the way around the limit.
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
    const limiter = new InfraNodeEnrollmentLimiter();
    const human = humanPrincipal('u-1');
    expect(attempt(limiter, human)).toBeUndefined();
    expect(attempt(limiter, human)).toBeInstanceOf(HttpException);
    // A different human, and the agent SA, are unaffected by that exhaustion.
    expect(attempt(limiter, humanPrincipal('u-2'))).toBeUndefined();
    expect(attempt(limiter, saPrincipal('sa-1'))).toBeUndefined();
  });

  it('an unidentified caller falls into a single shared bucket (never unbounded)', () => {
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
    const limiter = new InfraNodeEnrollmentLimiter();
    expect(attempt(limiter, undefined)).toBeUndefined();
    expect(attempt(limiter, undefined)).toBeInstanceOf(HttpException);
  });

  it('the key spaces are namespaced: a service account id equal to a user id cannot collide', () => {
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
    const limiter = new InfraNodeEnrollmentLimiter();
    expect(attempt(limiter, humanPrincipal('same-id'))).toBeUndefined();
    // Same raw id, different principal kind — a fresh bucket, not the human's exhausted one.
    expect(attempt(limiter, saPrincipal('same-id'))).toBeUndefined();
  });

  it('honours the env overrides', () => {
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '3';
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-1');
    for (let i = 0; i < 3; i++) expect(attempt(limiter, agent)).toBeUndefined();
    expect(attempt(limiter, agent)).toBeInstanceOf(HttpException);
  });

  describe('tryCharge — the non-throwing sibling for CHILD enrollments (#1139)', () => {
    it('shares ONE bucket with assertWithinBudget: a child node costs the same slot a host does', () => {
      // Two budgets would defeat the limit the moment one report can enrol N+1 rows: a container
      // node is a row on the same table and must be as bounded as the host that reported it.
      process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '2';
      const limiter = new InfraNodeEnrollmentLimiter();
      const agent = saPrincipal('sa-1');
      expect(attempt(limiter, agent)).toBeUndefined(); // the host
      expect(limiter.tryCharge(agent)).toBe(true); // one container
      expect(limiter.tryCharge(agent)).toBe(false); // budget spent
      expect(attempt(limiter, agent)).toBeInstanceOf(HttpException);
    });

    it('REFUSES rather than throws — a spent budget must never fail the host that reported', () => {
      // The host is already durable by the time children are reconciled. Throwing here would turn a
      // partially-enrolled container list into a 429 the agent reads as "the whole report failed",
      // and it would retry the identical report forever.
      process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
      const limiter = new InfraNodeEnrollmentLimiter();
      const agent = saPrincipal('sa-1');
      expect(limiter.tryCharge(agent)).toBe(true);
      expect(() => limiter.tryCharge(agent)).not.toThrow();
      expect(limiter.tryCharge(agent)).toBe(false);
    });

    it('recovers on the next window, with no operator action', () => {
      jest.useFakeTimers();
      process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = '1';
      process.env.INFRA_REPORT_NEW_NODE_WINDOW_MS = '60000';
      const limiter = new InfraNodeEnrollmentLimiter();
      const agent = saPrincipal('sa-1');
      expect(limiter.tryCharge(agent)).toBe(true);
      expect(limiter.tryCharge(agent)).toBe(false);
      jest.advanceTimersByTime(60_001);
      expect(limiter.tryCharge(agent)).toBe(true);
    });
  });

  it('ignores a non-numeric / non-positive override and keeps the safe default', () => {
    // A typo in a hand-edited env file must leave a limit that still limits — never one that
    // blocks every enrollment (`0`) and never one that is effectively off.
    process.env.INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW = 'nonsense';
    const limiter = new InfraNodeEnrollmentLimiter();
    const agent = saPrincipal('sa-1');
    for (let i = 0; i < INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW_DEFAULT; i++) {
      expect(attempt(limiter, agent)).toBeUndefined();
    }
    expect(attempt(limiter, agent)).toBeInstanceOf(HttpException);
  });
});
