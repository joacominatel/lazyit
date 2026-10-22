import type { ExecutionContext } from '@nestjs/common';
import {
  FixedWindowRateLimiter,
  RegisterRateLimitGuard,
  TokenRateLimitGuard,
  registrationRateKey,
} from './oauth-rate-limit';
import { REGISTER_RATE_LIMIT } from './oauth.constants';

function contextFor(ip: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as unknown as ExecutionContext;
}

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

describe('registrationRateKey — DCR keyed per IPv4 address or per IPv6 /64 (#1683)', () => {
  it('keeps an IPv4 address as is', () => {
    expect(registrationRateKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys an IPv6 address on its /64, whatever its spelling', () => {
    const key = '2001:db8:85a3:1::/64';
    expect(registrationRateKey('2001:db8:85a3:1::1')).toBe(key);
    expect(registrationRateKey('2001:0db8:85a3:0001:ffff:aaaa:bbbb:cccc')).toBe(
      key,
    );
    expect(registrationRateKey('2001:DB8:85A3:1:0:0:0:2')).toBe(key);
    expect(registrationRateKey('2001:db8:85a3:2::1')).toBe(
      '2001:db8:85a3:2::/64',
    );
    expect(registrationRateKey('::1')).toBe('0:0:0:0::/64');
    expect(registrationRateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(registrationRateKey('2001:db8::203.0.113.7')).toBe(
      '2001:db8:0:0::/64',
    );
  });

  it('keys an IPv4-mapped IPv6 address as the IPv4 it carries', () => {
    expect(registrationRateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(registrationRateKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('returns anything that is not an IP unchanged', () => {
    expect(registrationRateKey('unknown')).toBe('unknown');
    expect(registrationRateKey('2001:db8::1::2')).toBe('2001:db8::1::2');
  });
});

describe('RegisterRateLimitGuard (#1683)', () => {
  it('counts every address of one IPv6 /64 against one budget', () => {
    const guard = new RegisterRateLimitGuard();
    for (let i = 0; i < REGISTER_RATE_LIMIT.max; i += 1) {
      expect(guard.canActivate(contextFor(`2001:db8:1:2::${i + 1}`))).toBe(
        true,
      );
    }
    expect(() => guard.canActivate(contextFor('2001:db8:1:2:abcd::9'))).toThrow(
      'Http Exception',
    );
    // Another /64 and an IPv4 caller are unaffected.
    expect(guard.canActivate(contextFor('2001:db8:1:3::1'))).toBe(true);
    expect(guard.canActivate(contextFor('203.0.113.7'))).toBe(true);
  });

  it('leaves the other per-IP guards on the full address', () => {
    const guard = new TokenRateLimitGuard();
    const limiter = (guard as unknown as { limiter: FixedWindowRateLimiter })
      .limiter;
    const hit = jest.spyOn(limiter, 'hit');
    guard.canActivate(contextFor('2001:db8:1:2::1'));
    expect(hit).toHaveBeenCalledWith('2001:db8:1:2::1');
  });
});
