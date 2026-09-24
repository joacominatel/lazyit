import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AI_RUN_ERROR_CODES,
  type AiConnectionTestResult,
  type AiRunErrorCode,
} from '@lazyit/shared';
import { EgressError, type EgressDenyReason } from '../../common/egress/types';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
} from '../core/ports/chat-model.port';
import type { ResolvedAiProviderConfig } from '../core/ports/ai-settings.port';
import { withProviderOverride } from './ai-provider-override';
import {
  AI_CONNECTION_TEST_MAX_OUTPUT_TOKENS,
  AI_CONNECTION_TEST_TIMEOUT_MS,
} from './ai-settings.constants';

/** The dummy tool the tool-calling check asks the model to call (provider-and-runtime.md §9.1). */
const PING_TOOL = {
  name: 'ping',
  description: 'Connectivity check. Call this tool once, with no arguments.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

const PING_INSTRUCTIONS =
  'You are a connectivity check. Call the `ping` tool exactly once and do nothing else.';

/** Codes this tester adds to the run vocabulary (the wire `code` is an open string). */
export const AI_CONNECTION_TEST_CODES = {
  toolCallingUnsupported: 'TOOL_CALLING_UNSUPPORTED',
  providerLayerUnavailable: 'PROVIDER_LAYER_UNAVAILABLE',
} as const;

/**
 * Fixed, user-safe messages. The tester never echoes an upstream body, an SDK message or a credential:
 * a failure cannot become a reflected read (security.md §6.4) or a key leak (§6.5).
 */
const MESSAGES: Record<string, string> = {
  PROVIDER_AUTH: 'The provider rejected the credentials.',
  PROVIDER_BAD_REQUEST:
    'The provider refused the request — check the model id and the options.',
  PROVIDER_RATE_LIMIT:
    'The provider is rate limiting this key; try again later.',
  PROVIDER_UNAVAILABLE: 'The provider could not be reached.',
  PROVIDER_REFUSED: 'The provider refused to answer the test prompt.',
  EGRESS_DENIED:
    'The destination is not allowed by the egress policy (a private or http host needs the private-network option).',
  CANCELLED: 'The connection test timed out.',
  [AI_CONNECTION_TEST_CODES.toolCallingUnsupported]:
    'The model answered but did not call a tool — it cannot drive the assistant.',
  [AI_CONNECTION_TEST_CODES.providerLayerUnavailable]:
    'The provider layer is not available in this build.',
};

/** The provider-layer error classes (provider-and-runtime.md §6.3 `AiErrorClass`) mapped to run codes. */
const CLASS_TO_CODE: Record<string, AiRunErrorCode> = {
  auth: 'PROVIDER_AUTH',
  rate_limited: 'PROVIDER_RATE_LIMIT',
  unavailable: 'PROVIDER_UNAVAILABLE',
  bad_request: 'PROVIDER_BAD_REQUEST',
  refused: 'PROVIDER_REFUSED',
  egress_denied: 'EGRESS_DENIED',
};

const KNOWN_CODES: ReadonlySet<string> = new Set(AI_RUN_ERROR_CODES);

const UNREACHABLE_EGRESS_REASONS: ReadonlySet<EgressDenyReason> = new Set([
  'dns-resolution-failed',
  'request-timeout',
  'deadline-exceeded',
]);

/**
 * Classify a thrown model-call failure into a run error code. The port promises failures "thrown
 * classified"; this accepts a `code` from the run vocabulary, or an `errorClass` / `class` from the
 * provider layer's `AiErrorClass`, recognizes the egress guard's own error and the abort, and falls back
 * to `PROVIDER_UNAVAILABLE`. It reads only those tags — never the message.
 */
export function classifyProviderFailure(err: unknown): string {
  if (err instanceof EgressError) {
    // A timeout or a DNS miss is an unreachable provider; everything else is the policy refusing.
    return UNREACHABLE_EGRESS_REASONS.has(err.reason)
      ? 'PROVIDER_UNAVAILABLE'
      : 'EGRESS_DENIED';
  }
  if (err && typeof err === 'object') {
    const tagged = err as {
      code?: unknown;
      errorClass?: unknown;
      class?: unknown;
      name?: unknown;
    };
    if (typeof tagged.code === 'string' && KNOWN_CODES.has(tagged.code)) {
      return tagged.code;
    }
    for (const tag of [tagged.errorClass, tagged.class]) {
      if (typeof tag === 'string' && CLASS_TO_CODE[tag])
        return CLASS_TO_CODE[tag];
    }
    if (tagged.name === 'AbortError' || tagged.name === 'TimeoutError') {
      return 'CANCELLED';
    }
  }
  return 'PROVIDER_UNAVAILABLE';
}

function failure(
  code: string,
  checks: AiConnectionTestResult['checks'],
  latencyMs: number | null,
): AiConnectionTestResult {
  return {
    ok: false,
    checks,
    latencyMs,
    error: { code, message: MESSAGES[code] ?? MESSAGES.PROVIDER_UNAVAILABLE },
  };
}

/**
 * The connection tester (provider-and-runtime.md §9.1): ONE model step through `ChatModelPort` with a
 * dummy `ping` tool, run under the draft provider configuration. It answers the three checks —
 *   - `auth`        the provider accepted the credentials;
 *   - `model`       the model id exists and answered;
 *   - `toolCalling` the model proposed a tool call (catches local models without tool support) —
 * and `ok` only when all three pass. A failed `auth` leaves the other two `null` (not run).
 *
 * The port is resolved lazily from the application container rather than by importing
 * `AiProvidersModule`: the provider layer reads its configuration from this module's
 * `AI_SETTINGS_READER`, so a static import both ways would be a module cycle.
 */
@Injectable()
export class AiConnectionTester {
  private readonly logger = new Logger(AiConnectionTester.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async test(
    config: ResolvedAiProviderConfig,
  ): Promise<AiConnectionTestResult> {
    const port = this.resolvePort();
    if (!port) {
      return failure(
        AI_CONNECTION_TEST_CODES.providerLayerUnavailable,
        { auth: null, model: null, toolCalling: null },
        null,
      );
    }

    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      AI_CONNECTION_TEST_TIMEOUT_MS,
    );
    const started = Date.now();
    try {
      const result = await withProviderOverride(config, () =>
        port.step({
          model: { provider: config.provider, modelId: config.model },
          instructions: PING_INSTRUCTIONS,
          messages: [port.userMessage('ping')],
          tools: [PING_TOOL],
          toolChoice: 'auto',
          maxOutputTokens: AI_CONNECTION_TEST_MAX_OUTPUT_TOKENS,
          abortSignal: abort.signal,
        }),
      );
      const latencyMs = Date.now() - started;
      const calledPing = result.toolCalls.some(
        (call) => call.toolName === PING_TOOL.name,
      );
      if (!calledPing) {
        return failure(
          AI_CONNECTION_TEST_CODES.toolCallingUnsupported,
          { auth: true, model: true, toolCalling: false },
          latencyMs,
        );
      }
      return {
        ok: true,
        checks: { auth: true, model: true, toolCalling: true },
        latencyMs,
        error: null,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const code = abort.signal.aborted
        ? 'CANCELLED'
        : classifyProviderFailure(err);
      // Metadata only (ADR-0031): the code and provider, never the error's message or body.
      this.logger.warn(
        `AI connection test failed: provider=${config.provider} code=${code}`,
      );
      return failure(code, checksFor(code), latencyMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private resolvePort(): ChatModelPort | null {
    try {
      return this.moduleRef.get<ChatModelPort>(CHAT_MODEL_PORT, {
        strict: false,
      });
    } catch {
      return null;
    }
  }
}

/** Which checks a failure code answers: auth failed → nothing after it ran; a bad request → the model. */
function checksFor(code: string): AiConnectionTestResult['checks'] {
  switch (code) {
    case 'PROVIDER_AUTH':
      return { auth: false, model: null, toolCalling: null };
    case 'PROVIDER_BAD_REQUEST':
    case 'PROVIDER_REFUSED':
      return { auth: true, model: false, toolCalling: null };
    default:
      return { auth: null, model: null, toolCalling: null };
  }
}
