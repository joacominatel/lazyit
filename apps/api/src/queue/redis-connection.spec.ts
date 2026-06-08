import { EventEmitter } from 'node:events';
import type IORedis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import {
  attachConnectionLogging,
  buildRedisConnection,
  buildRetryStrategy,
  createErrorLogThrottler,
  DEFAULT_REDIS_URL,
  isQueueUnavailableError,
  REDIS_MAX_BACKOFF_MS,
  REDIS_MAX_RECONNECT_ATTEMPTS,
  redactRedisUrl,
  redisConnectionOptions,
  resolveRedisUrl,
  type ConnectionLogger,
} from './redis-connection';

/** A single-string logger spy (typed args so `.mock.calls[i][0]` stays `string`, not `any`). */
type LogSpy = jest.Mock<void, [string]>;

/** A logger spy capturing each level. */
function makeLogger(): ConnectionLogger & {
  log: LogSpy;
  warn: LogSpy;
  error: LogSpy;
} {
  return {
    log: jest.fn<void, [string]>(),
    warn: jest.fn<void, [string]>(),
    error: jest.fn<void, [string]>(),
  };
}

describe('resolveRedisUrl', () => {
  it('uses REDIS_URL when set', () => {
    expect(resolveRedisUrl({ REDIS_URL: 'redis://valkey:6379' })).toEqual({
      url: 'redis://valkey:6379',
      usedDefault: false,
    });
  });

  it('falls back to the default (127.0.0.1, not localhost) when unset', () => {
    const r = resolveRedisUrl({});
    expect(r).toEqual({ url: DEFAULT_REDIS_URL, usedDefault: true });
    expect(r.url).toContain('127.0.0.1');
  });

  it('treats a blank / whitespace-only REDIS_URL as unset', () => {
    expect(resolveRedisUrl({ REDIS_URL: '   ' })).toEqual({
      url: DEFAULT_REDIS_URL,
      usedDefault: true,
    });
  });
});

describe('redactRedisUrl (never log a secret)', () => {
  it('redacts the password but keeps host/port/user', () => {
    const out = redactRedisUrl('redis://app:s3cr3t@valkey:6379/0');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('***');
    expect(out).toContain('valkey:6379');
    expect(out).toContain('app');
  });

  it('redacts a password-only userinfo (redis://:pass@host)', () => {
    const out = redactRedisUrl('redis://:topsecret@valkey:6379');
    expect(out).not.toContain('topsecret');
    expect(out).toContain('***');
  });

  it('leaves a credential-free URL essentially unchanged', () => {
    expect(redactRedisUrl('redis://valkey:6379')).toContain('valkey:6379');
    expect(redactRedisUrl('redis://valkey:6379')).not.toContain('***');
  });

  it('handles the rediss:// (TLS) scheme', () => {
    const out = redactRedisUrl('rediss://app:hunter2@valkey:6380');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
  });

  it('falls back to a regex strip when the URL is unparseable', () => {
    const out = redactRedisUrl('not a url://user:pw@host');
    expect(out).not.toContain('pw');
    expect(out).toContain('***@');
  });
});

describe('buildRetryStrategy (bounded — never retry forever)', () => {
  it('caps the backoff at REDIS_MAX_BACKOFF_MS', () => {
    const strat = buildRetryStrategy();
    expect(strat(1)).toBeLessThanOrEqual(REDIS_MAX_BACKOFF_MS);
    // A high (but still within-attempts) value saturates the cap.
    expect(strat(REDIS_MAX_RECONNECT_ATTEMPTS)).toBe(REDIS_MAX_BACKOFF_MS);
  });

  it('grows the backoff with the attempt count (before the cap)', () => {
    const strat = buildRetryStrategy({ stepMs: 100, maxBackoffMs: 10_000 });
    expect(strat(1)).toBe(100);
    expect(strat(2)).toBe(200);
  });

  it('returns null (stop reconnecting) once max attempts is exceeded', () => {
    const strat = buildRetryStrategy({ maxAttempts: 3 });
    expect(strat(3)).not.toBeNull();
    expect(strat(4)).toBeNull();
    expect(strat(99)).toBeNull();
  });

  it('calls onGiveUp exactly once when it gives up', () => {
    const onGiveUp = jest.fn();
    const strat = buildRetryStrategy({ maxAttempts: 2, onGiveUp });
    strat(3);
    strat(4);
    strat(5);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith(2);
  });
});

describe('createErrorLogThrottler (anti-flood)', () => {
  it('logs the first error loudly, then throttles within the window', () => {
    const logger = makeLogger();
    let now = 1_000_000;
    const log = createErrorLogThrottler(logger, 10_000, () => now);

    log(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    expect(logger.error).toHaveBeenCalledTimes(1);

    // 50 more errors within the window → still only the first log.
    for (let i = 0; i < 50; i++) {
      now += 100;
      log(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    }
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs again once the throttle window elapses, with a running count', () => {
    const logger = makeLogger();
    let now = 0;
    const log = createErrorLogThrottler(logger, 10_000, () => now);

    log(new Error('boom')); // 1st (logged)
    now = 5_000;
    log(new Error('boom')); // within window (suppressed)
    now = 11_000;
    log(new Error('boom')); // window elapsed (logged again)

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[1][0]).toContain('still failing');
    expect(logger.error.mock.calls[1][0]).toContain('3 errors so far');
  });
});

describe('redisConnectionOptions (BullMQ interplay + fail-fast)', () => {
  const opts: RedisOptions = redisConnectionOptions();

  it('keeps maxRetriesPerRequest null (BullMQ blocking-command requirement)', () => {
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('disables the offline queue so producer enqueues fail fast (503 path)', () => {
    expect(opts.enableOfflineQueue).toBe(false);
  });

  it('installs a bounded retryStrategy function', () => {
    expect(typeof opts.retryStrategy).toBe('function');
    const strat = opts.retryStrategy as (t: number) => number | null;
    expect(strat(REDIS_MAX_RECONNECT_ATTEMPTS + 1)).toBeNull();
  });
});

describe('isQueueUnavailableError', () => {
  it('flags ioredis offline-queue-disabled rejections', () => {
    expect(
      isQueueUnavailableError(
        new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        ),
      ),
    ).toBe(true);
  });

  it('flags a closed/ended connection', () => {
    expect(isQueueUnavailableError(new Error('Connection is closed.'))).toBe(
      true,
    );
  });

  it('flags MaxRetriesPerRequestError by name', () => {
    const err = new Error('reached the max retries per request limit');
    err.name = 'MaxRetriesPerRequestError';
    expect(isQueueUnavailableError(err)).toBe(true);
  });

  it('flags raw connect errnos via the code property', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(isQueueUnavailableError(err)).toBe(true);
  });

  it('does NOT flag unrelated errors (those should surface as 500)', () => {
    expect(isQueueUnavailableError(new Error('some validation bug'))).toBe(
      false,
    );
    expect(isQueueUnavailableError('not an error')).toBe(false);
    expect(isQueueUnavailableError(undefined)).toBe(false);
  });
});

/** A fake ioredis: an EventEmitter that satisfies the `.on` surface buildRedisConnection wires. */
function fakeClient(): EventEmitter {
  return new EventEmitter();
}

describe('buildRedisConnection (boot logging + wiring)', () => {
  it('logs the redacted target (no secret) when REDIS_URL is set', () => {
    const logger = makeLogger();
    const created: { url: string; options: RedisOptions }[] = [];
    buildRedisConnection(
      { REDIS_URL: 'redis://app:s3cr3t@valkey:6379' },
      logger,
      (url, options) => {
        created.push({ url, options });
        return fakeClient() as unknown as IORedis;
      },
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = logger.log.mock.calls[0][0];
    expect(line).toContain('valkey:6379');
    expect(line).not.toContain('s3cr3t');
    // The live client still gets the REAL url (with credentials) — only the LOG is redacted.
    expect(created[0].url).toBe('redis://app:s3cr3t@valkey:6379');
    expect(created[0].options.enableOfflineQueue).toBe(false);
    expect(created[0].options.maxRetriesPerRequest).toBeNull();
  });

  it('WARNs loudly when REDIS_URL is unset (the #257 default fallback)', () => {
    const logger = makeLogger();
    buildRedisConnection({}, logger, () => fakeClient() as unknown as IORedis);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('REDIS_URL is not set');
    expect(line).toContain('redis://valkey:6379');
  });

  it('wires throttled error / ready / end logging onto the client', () => {
    const logger = makeLogger();
    const client = fakeClient();
    buildRedisConnection(
      { REDIS_URL: 'redis://valkey:6379' },
      logger,
      () => client as unknown as IORedis,
    );
    // boot 'log' line already fired once; now drive lifecycle events.
    client.emit('error', new Error('connect ECONNREFUSED'));
    client.emit('error', new Error('connect ECONNREFUSED')); // throttled
    expect(logger.error).toHaveBeenCalledTimes(1);

    client.emit('ready');
    expect(logger.log).toHaveBeenCalledTimes(2); // boot line + "Connected ... ready"

    client.emit('end');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('attachConnectionLogging', () => {
  it('logs ready and end with the redacted URL', () => {
    const logger = makeLogger();
    const client = fakeClient();
    attachConnectionLogging(
      client as unknown as IORedis,
      logger,
      'redis://valkey:6379',
    );
    client.emit('ready');
    client.emit('end');
    expect(logger.log.mock.calls[0][0]).toContain('valkey:6379');
    expect(logger.warn.mock.calls[0][0]).toContain('valkey:6379');
  });
});
