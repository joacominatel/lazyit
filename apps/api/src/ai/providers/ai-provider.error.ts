import type { AiRunErrorCode } from '@lazyit/shared';

/**
 * The run error codes a model call can fail with (provider-and-runtime.md §6.3 `classifyError`, §11). A
 * subset of the shared `AI_RUN_ERROR_CODES`, so the runtime can put the code on `run.finished` as is.
 */
export type AiProviderErrorCode = Extract<
  AiRunErrorCode,
  | 'AI_DISABLED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_REFUSED'
  | 'EGRESS_DENIED'
  | 'CONTEXT_LIMIT'
  | 'CANCELLED'
  | 'CONVERSATION_READ_ONLY'
  | 'WEB_SEARCH_DISABLED'
>;

/** The fixed, user-safe message per code. Never the upstream body, a header or the key (security §6.5). */
const MESSAGES: Record<AiProviderErrorCode, string> = {
  AI_DISABLED: 'The AI assistant is not configured.',
  PROVIDER_AUTH: 'The AI provider rejected the credentials.',
  PROVIDER_RATE_LIMIT: 'The AI provider is rate limiting requests.',
  PROVIDER_UNAVAILABLE: 'The AI provider is unavailable.',
  PROVIDER_BAD_REQUEST: 'The AI provider rejected the request.',
  PROVIDER_REFUSED: 'The AI provider refused to answer.',
  EGRESS_DENIED: 'The AI provider address is not allowed.',
  CONTEXT_LIMIT: 'The conversation is too long for the model.',
  CANCELLED: 'The model call was cancelled.',
  CONVERSATION_READ_ONLY:
    'The conversation belongs to a different provider configuration.',
  WEB_SEARCH_DISABLED:
    'The AI provider refused web search: it is disabled for this account. Enable web search at the provider, or turn it off in Settings → AI.',
};

/**
 * A classified model-call failure: what `ChatModelPort.step` and the connection probe throw. It carries a
 * code, a fixed message and, for rate limits, the provider's retry hint — and deliberately NO `cause`: SDK
 * errors hold the request body (the prompt) and the upstream response, which must not travel into logs,
 * run rows or the wire.
 *
 * This file imports nothing from the AI SDK, so the runtime can `instanceof` it without pulling `ai` into
 * its import graph.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  /** Seconds the provider asked to wait (rate limits only), when it said so. */
  readonly retryAfterSec?: number;
  /** The upstream HTTP status, when there was one. Diagnostic metadata only. */
  readonly status?: number;

  constructor(
    code: AiProviderErrorCode,
    details: { retryAfterSec?: number; status?: number } = {},
  ) {
    super(MESSAGES[code]);
    this.name = 'AiProviderError';
    this.code = code;
    if (details.retryAfterSec !== undefined) {
      this.retryAfterSec = details.retryAfterSec;
    }
    if (details.status !== undefined) {
      this.status = details.status;
    }
    Object.setPrototypeOf(this, AiProviderError.prototype);
  }
}

/** Thrown when the SDK tries to download a message's file URL (see `experimental_download` below). */
export class ProviderDownloadRefusedError extends Error {
  constructor() {
    super('The provider layer never downloads URLs referenced by a message');
    this.name = 'ProviderDownloadRefusedError';
    Object.setPrototypeOf(this, ProviderDownloadRefusedError.prototype);
  }
}
