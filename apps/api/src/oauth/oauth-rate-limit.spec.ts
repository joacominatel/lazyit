import { FixedWindowRateLimiter } from './oauth-rate-limit';

describe('FixedWindowRateLimiter', () => {
  it('reports exhaustion without counting, and forgets old windows', () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect(limiter.exhausted('ip', 0)).toBe(false);
    limiter.hit('ip', 0);
    limiter.hit('ip', 0);
    expect(limiter.exhausted('ip', 10)).toBe(true);
    expect(limiter.hit('ip', 10)).toBe(false);
    expect(limiter.exhausted('ip', 1000)).toBe(false);
    expect(limiter.hit('ip', 1000)).toBe(true);
  });

  it('keeps at most maxKeys buckets, evicting the oldest window (AUD-005)', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, 2);
    expect(limiter.hit('a', 0)).toBe(true);
    expect(limiter.hit('a', 1)).toBe(false);
    expect(limiter.hit('b', 2)).toBe(true);
    expect(limiter.hit('c', 3)).toBe(true);

    // `a` held the oldest window and was evicted: it starts a fresh count. `b` was kept.
    expect(limiter.exhausted('a', 4)).toBe(false);
    expect(limiter.hit('b', 4)).toBe(false);
    expect(limiter.exhausted('c', 4)).toBe(true);
  });

  it('drops expired windows before evicting a live one', () => {
    const limiter = new FixedWindowRateLimiter(1, 100, 2);
    limiter.hit('a', 0);
    limiter.hit('b', 50);
    expect(limiter.hit('c', 120)).toBe(true);
    expect(limiter.hit('b', 120)).toBe(false);
    expect(limiter.hit('c', 121)).toBe(false);
  });

  it('restarts a key whose own window elapsed, even behind live buckets', () => {
    const limiter = new FixedWindowRateLimiter(1, 100);
    limiter.hit('a', 50);
    limiter.hit('b', 0);
    expect(limiter.hit('b', 100)).toBe(true);
    expect(limiter.hit('a', 100)).toBe(false);
  });
});
