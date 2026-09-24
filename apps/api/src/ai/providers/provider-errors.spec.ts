import {
  APICallError,
  InvalidPromptError,
  LoadAPIKeyError,
  RetryError,
  StreamProviderError,
} from 'ai';

import { EgressError } from '../../common/egress';
import { AiProviderError } from './ai-provider.error';
import { classifyProviderError, retryAfterSeconds } from './provider-errors';
import { SECRET_KEY } from './provider.harness-spec';

const patterns = {
  contextLimit: /prompt is too long/i,
  auth: /API key not valid/i,
};

function apiError(
  statusCode: number | undefined,
  message = 'upstream',
  extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example/v1',
    requestBodyValues: { prompt: 'secret prompt', key: SECRET_KEY },
    statusCode,
    responseHeaders: { authorization: `Bearer ${SECRET_KEY}` },
    responseBody: '{"error":"upstream body"}',
    ...extra,
  });
}

describe('classifyProviderError', () => {
  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [404, 'PROVIDER_BAD_REQUEST'],
    [422, 'PROVIDER_BAD_REQUEST'],
    [408, 'PROVIDER_UNAVAILABLE'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [529, 'PROVIDER_UNAVAILABLE'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(classifyProviderError(apiError(status), patterns).code).toBe(code);
  });

  it('recognizes a context-length 400 by the provider wording or the generic one', () => {
    expect(
      classifyProviderError(
        apiError(400, 'prompt is too long: 9 > 8'),
        patterns,
      ).code,
    ).toBe('CONTEXT_LIMIT');
    expect(
      classifyProviderError(
        apiError(400, 'bad', {
          responseBody: 'maximum context length is 8192',
        }),
        patterns,
      ).code,
    ).toBe('CONTEXT_LIMIT');
  });

  it("recognizes a provider's 400 for a bad key as PROVIDER_AUTH", () => {
    expect(
      classifyProviderError(apiError(400, 'API key not valid.'), patterns).code,
    ).toBe('PROVIDER_AUTH');
  });

  it('keeps the retry hint of a rate limit', () => {
    const err = classifyProviderError(
      apiError(429, 'slow', { responseHeaders: { 'Retry-After': '12' } }),
      patterns,
    );
    expect(err).toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryAfterSec: 12,
    });
  });

  it('unwraps the last error of exhausted SDK retries, and maps a retry abort to CANCELLED', () => {
    const exhausted = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(429)],
    });
    expect(classifyProviderError(exhausted, patterns).code).toBe(
      'PROVIDER_RATE_LIMIT',
    );
    const aborted = new RetryError({
      message: 'x',
      reason: 'abort',
      errors: [],
    });
    expect(classifyProviderError(aborted, patterns).code).toBe('CANCELLED');
  });

  it('maps an egress refusal to EGRESS_DENIED and an egress timeout to PROVIDER_UNAVAILABLE, even wrapped', () => {
    const denied = new EgressError('blocked-address', 'nope');
    const timeout = new EgressError('deadline-exceeded', 'slow');
    expect(classifyProviderError(denied, patterns).code).toBe('EGRESS_DENIED');
    expect(
      classifyProviderError(
        apiError(undefined, 'x', { cause: denied }),
        patterns,
      ).code,
    ).toBe('EGRESS_DENIED');
    expect(classifyProviderError(timeout, patterns).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
  });

  it('treats a stream cut after the headers (cause "aborted", egress reason lost) as unavailable', () => {
    const cut = apiError(undefined, 'Cannot connect', {
      cause: new Error('aborted'),
    });
    expect(classifyProviderError(cut, patterns).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
  });

  it('maps anything after our own abort to CANCELLED', () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      classifyProviderError(apiError(500), patterns, controller.signal).code,
    ).toBe('CANCELLED');
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    expect(classifyProviderError(abortError, patterns).code).toBe('CANCELLED');
  });

  it('classifies an error event inside a started stream', () => {
    const overloaded = new StreamProviderError({
      message: 'Overloaded',
      type: 'overloaded_error',
    });
    const limited = new StreamProviderError({
      message: 'x',
      type: 'rate_limit_error',
    });
    const withStatus = new StreamProviderError({
      message: 'x',
      statusCode: 401,
    });
    expect(classifyProviderError(overloaded, patterns).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(classifyProviderError(limited, patterns).code).toBe(
      'PROVIDER_RATE_LIMIT',
    );
    expect(classifyProviderError(withStatus, patterns).code).toBe(
      'PROVIDER_AUTH',
    );
  });

  it('maps a missing key, a malformed prompt and anything unknown', () => {
    expect(
      classifyProviderError(
        new LoadAPIKeyError({ message: 'no key' }),
        patterns,
      ).code,
    ).toBe('PROVIDER_AUTH');
    expect(
      classifyProviderError(
        new InvalidPromptError({ prompt: {}, message: 'system in messages' }),
        patterns,
      ).code,
    ).toBe('PROVIDER_BAD_REQUEST');
    expect(classifyProviderError(new Error('boom'), patterns).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    const already = new AiProviderError('CONTEXT_LIMIT');
    expect(classifyProviderError(already, patterns)).toBe(already);
  });

  it('produces an error with a fixed message and no cause, headers, body or key', () => {
    const err = classifyProviderError(
      apiError(401, `bad key ${SECRET_KEY}`),
      patterns,
    );

    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toBe('The AI provider rejected the credentials.');
    expect(err).not.toHaveProperty('cause');
    const dump = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
    expect(dump).not.toContain(SECRET_KEY);
    expect(dump).not.toContain('secret prompt');
    expect(dump).not.toContain('upstream body');
  });
});

describe('retryAfterSeconds', () => {
  it('reads retry-after-ms, retry-after seconds and an HTTP date', () => {
    expect(retryAfterSeconds({ 'retry-after-ms': '1500' })).toBe(2);
    expect(retryAfterSeconds({ 'retry-after': '30' })).toBe(30);
    const now = Date.parse('2026-09-24T10:00:00Z');
    expect(
      retryAfterSeconds(
        { 'retry-after': 'Thu, 24 Sep 2026 10:00:45 GMT' },
        now,
      ),
    ).toBe(45);
    expect(retryAfterSeconds({ 'retry-after': 'soon' })).toBeUndefined();
    expect(retryAfterSeconds(undefined)).toBeUndefined();
  });
});
