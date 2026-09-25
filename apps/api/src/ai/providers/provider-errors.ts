import {
  APICallError,
  LoadAPIKeyError,
  RetryError,
  StreamProviderError,
} from 'ai';

import { EgressError } from '../../common/egress';
import {
  AiProviderError,
  ProviderDownloadRefusedError,
} from './ai-provider.error';
import { ProviderResponseTooLargeError } from './provider-fetch';
import type { ProviderErrorPatterns } from './provider.types';

/**
 * Normalize whatever a model call threw into an {@link AiProviderError} (provider-and-runtime.md §6.3
 * `classifyError`; security.md §6.5 "wrap provider SDK errors into lazyit errors that carry no headers or
 * bodies"). The upstream message and body are read ONLY to classify; the resulting error has a fixed
 * message and no `cause`.
 */

/** Wording shared by most providers for a prompt that exceeds the context window. */
const GENERIC_CONTEXT_LIMIT =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long/i;

/**
 * A provider refusing its server-side web search tool because the account disabled it (#1315, follow-up of
 * #1389). Read only when the step actually carried the tool. The shapes, per the providers' docs:
 *   - Anthropic: a 400 `invalid_request_error` "that says web search is not enabled" when an administrator
 *     disabled it in the Claude Console (web-search-tool docs, "How to use web search");
 *   - OpenAI: hosted tools are allowed or denied per organization / project (`hosted_tool_permissions`); a
 *     denied tool is refused with an `invalid_request_error` such as "Web Search tool is not enabled for
 *     this organization" (the Azure OpenAI wording is the same).
 * A model that does not SUPPORT the tool ("Hosted tool 'web_search_preview' is not supported with …") is
 * not a setting the admin can flip at the provider and stays a bad request.
 */
const WEB_SEARCH_DISABLED =
  /web[ _-]?search(?:[ _-]?preview)?\b[^.\n]{0,80}?\b(?:(?:is|was|has been)\s+)?(?:not\s+(?:been\s+)?enabled|disabled|not\s+(?:allowed|permitted))/i;

/** Whether a failed step's upstream text says the web search tool is disabled for the account. */
export function isWebSearchDisabled(text: string): boolean {
  return WEB_SEARCH_DISABLED.test(text);
}

/** Per-call facts the classifier may read: whether the step carried the provider's web search tool. */
export interface ClassifyContext {
  webSearch?: boolean;
}

/** The transient statuses: timeouts, overload and server errors. */
function isUnavailableStatus(status: number): boolean {
  return status === 408 || status === 529 || status >= 500;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** `retry-after-ms`, then `retry-after` (seconds or an HTTP date), as whole seconds. */
export function retryAfterSeconds(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): number | undefined {
  const ms = Number(headerValue(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) {
    return Math.ceil(ms / 1000);
  }
  const raw = headerValue(headers, 'retry-after');
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - now) / 1000));
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

/** The first error of a given class in the error's `cause` chain (the SDK wraps transport errors). */
function findInChain<T>(
  err: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof type) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Classify an HTTP error status (also used by model listing, which calls `fetch` directly). */
export function classifyHttpStatus(
  status: number,
  text: string,
  patterns: ProviderErrorPatterns,
  headers?: Record<string, string>,
  context: ClassifyContext = {},
): AiProviderError {
  // Before the auth mapping: a provider may answer a denied hosted tool with a 403 as well as a 400.
  if (
    context.webSearch === true &&
    status >= 400 &&
    status < 500 &&
    status !== 429 &&
    isWebSearchDisabled(text)
  ) {
    return new AiProviderError('WEB_SEARCH_DISABLED', { status });
  }
  if (status === 401 || status === 403) {
    return new AiProviderError('PROVIDER_AUTH', { status });
  }
  if (status === 429) {
    return new AiProviderError('PROVIDER_RATE_LIMIT', {
      status,
      retryAfterSec: retryAfterSeconds(headers),
    });
  }
  if (isUnavailableStatus(status)) {
    return new AiProviderError('PROVIDER_UNAVAILABLE', { status });
  }
  if (patterns.auth?.test(text)) {
    return new AiProviderError('PROVIDER_AUTH', { status });
  }
  if (patterns.contextLimit.test(text) || GENERIC_CONTEXT_LIMIT.test(text)) {
    return new AiProviderError('CONTEXT_LIMIT', { status });
  }
  return new AiProviderError('PROVIDER_BAD_REQUEST', { status });
}

export function classifyProviderError(
  err: unknown,
  patterns: ProviderErrorPatterns,
  signal?: AbortSignal,
  context: ClassifyContext = {},
): AiProviderError {
  if (err instanceof AiProviderError) {
    return err;
  }
  if (signal?.aborted) {
    return new AiProviderError('CANCELLED');
  }
  if (RetryError.isInstance(err)) {
    if (err.reason === 'abort') {
      return new AiProviderError('CANCELLED');
    }
    return classifyProviderError(err.lastError, patterns, signal, context);
  }
  if (LoadAPIKeyError.isInstance(err)) {
    return new AiProviderError('PROVIDER_AUTH');
  }

  // A refusal before any byte (the guard) keeps its reason; a timeout is an unavailable provider.
  // A file URL the SDK wanted to fetch outside the egress guard: refused by policy.
  if (findInChain(err, ProviderDownloadRefusedError)) {
    return new AiProviderError('EGRESS_DENIED');
  }
  // An oversized body (the provider-fetch cap) is a provider misbehaving, not a policy refusal.
  if (findInChain(err, ProviderResponseTooLargeError)) {
    return new AiProviderError('PROVIDER_UNAVAILABLE');
  }
  const egress = findInChain(err, EgressError);
  if (egress) {
    return egress.reason === 'request-timeout' ||
      egress.reason === 'deadline-exceeded'
      ? new AiProviderError('PROVIDER_UNAVAILABLE')
      : new AiProviderError('EGRESS_DENIED');
  }

  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) {
      // No response status: a transport failure. After the headers, a cut stream surfaces as
      // `cause: Error('aborted')` and the egress reason is lost (W1-B finding 3) — transient either way.
      return isAbort(err.cause)
        ? new AiProviderError('CANCELLED')
        : new AiProviderError('PROVIDER_UNAVAILABLE');
    }
    return classifyHttpStatus(
      err.statusCode,
      `${err.message} ${err.responseBody ?? ''}`,
      patterns,
      err.responseHeaders,
      context,
    );
  }

  if (StreamProviderError.isInstance(err)) {
    // An error event inside an already-started stream (e.g. Anthropic `overloaded_error`).
    if (err.statusCode !== undefined) {
      return classifyHttpStatus(
        err.statusCode,
        `${err.message} ${String(err.type ?? '')} ${String(err.code ?? '')}`,
        patterns,
        undefined,
        context,
      );
    }
    const kind = `${String(err.type ?? '')} ${String(err.code ?? '')}`;
    if (/rate[_ -]?limit/i.test(kind)) {
      return new AiProviderError('PROVIDER_RATE_LIMIT');
    }
    if (/auth|permission/i.test(kind)) {
      return new AiProviderError('PROVIDER_AUTH');
    }
    if (patterns.contextLimit.test(err.message)) {
      return new AiProviderError('CONTEXT_LIMIT');
    }
    return new AiProviderError('PROVIDER_UNAVAILABLE');
  }

  if (isAbort(err)) {
    return new AiProviderError('CANCELLED');
  }
  if (err instanceof Error && err.name.startsWith('AI_')) {
    // Any other SDK error (an invalid prompt, an unsupported feature…) is a request the provider layer
    // could not form: a bad request, not an outage.
    return new AiProviderError('PROVIDER_BAD_REQUEST');
  }
  return new AiProviderError('PROVIDER_UNAVAILABLE');
}
