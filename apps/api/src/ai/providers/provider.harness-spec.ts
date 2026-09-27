/**
 * Shared test kit for the provider specs (not a spec itself: the `-spec.ts` suffix keeps it out of the
 * build — `tsconfig.build.json` excludes `*spec.ts` — while Jest only runs `*.spec.ts`).
 *
 * The provider specs run the REAL provider packages against a scripted `fetch`: the upstream wire (SSE
 * streams, JSON errors) is hand-written from each provider's documented format and streamed chunk by
 * chunk with the SDK's own test utility (`convertArrayToReadableStream` from `ai/test`). No network.
 */
import { inspect } from 'node:util';

import { Logger } from '@nestjs/common';
import { convertArrayToReadableStream } from 'ai/test';

import type {
  AiSettingsReader,
  ResolvedAiProviderConfig,
} from '../core/ports/ai-settings.port';
import type {
  ChatModelStepRequest,
  ChatModelToolDefinition,
} from '../core/ports/chat-model.port';
import { AiSdkChatModel } from './aisdk-chat-model';
import type { FetchLike } from './provider.types';

/** A key that must never appear in an error or a log line. */
export const SECRET_KEY = 'sk-lazyit-TEST-SECRET-9f3a7c';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Responder = (request: RecordedRequest) => Response;

/** A fake upstream: one responder per call, every request recorded (headers lower-cased). */
export function scriptedFetch(responders: Responder[]): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    requests.push(request);
    const responder = responders[requests.length - 1];
    if (!responder) {
      return Promise.reject(
        new Error(`unexpected provider call #${requests.length}`),
      );
    }
    return Promise.resolve(responder(request));
  };
  return { fetch, requests };
}

/** An SSE response streamed one event per chunk. */
export function sseResponse(
  events: Array<{ event?: string; data: unknown } | string>,
): Response {
  const encoder = new TextEncoder();
  const chunks = events.map((e) =>
    encoder.encode(
      typeof e === 'string'
        ? e
        : `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`,
    ),
  );
  return new Response(convertArrayToReadableStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function providerConfig(
  overrides: Partial<ResolvedAiProviderConfig> = {},
): ResolvedAiProviderConfig {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: null,
    apiKey: SECRET_KEY,
    allowPrivateNetwork: false,
    effort: null,
    providerOptions: null,
    ...overrides,
  };
}

export const SEARCH_TOOL: ChatModelToolDefinition = {
  name: 'lazyit_search',
  description: 'Search lazyit.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};

export function stepRequest(
  config: ResolvedAiProviderConfig,
  overrides: Partial<ChatModelStepRequest> = {},
): ChatModelStepRequest {
  return {
    model: { provider: config.provider, modelId: config.model },
    instructions: 'frozen system prompt',
    messages: [{ role: 'user', content: 'Find the MacBook' }],
    tools: [SEARCH_TOOL],
    toolChoice: 'auto',
    maxOutputTokens: 1024,
    ...overrides,
  };
}

export function readerFor(
  config: ResolvedAiProviderConfig | null,
): AiSettingsReader {
  return {
    getSettings: () => Promise.reject(new Error('not used')),
    resolveProviderConfig: () => Promise.resolve(config),
  };
}

/** The port, wired to a fixed configuration and a scripted upstream, with SDK retries off. */
export function chatModelFor(
  config: ResolvedAiProviderConfig,
  fetch: FetchLike,
): AiSdkChatModel {
  return new AiSdkChatModel(readerFor(config), {
    fetchFactory: () => fetch,
    maxRetries: 0,
  });
}

/** Everything written through the Nest logger or the console while `run` executes. */
export async function captureLogs(
  run: () => Promise<unknown>,
): Promise<string> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(
      // Rendered as the console would print it: every own property of an error, nested ones included.
      args
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join(' '),
    );
  };
  const spies = [
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record),
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(record),
    jest.spyOn(Logger.prototype, 'error').mockImplementation(record),
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(record),
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(record),
    jest.spyOn(console, 'log').mockImplementation(record),
    jest.spyOn(console, 'warn').mockImplementation(record),
    jest.spyOn(console, 'error').mockImplementation(record),
    jest.spyOn(console, 'info').mockImplementation(record),
    jest.spyOn(console, 'debug').mockImplementation(record),
  ];
  try {
    await run().catch((err: unknown) => record(err));
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return lines.join('\n');
}

/** Serialize an error the way a log line or a run row could: message, stack and own properties. */
export function dumpError(err: unknown): string {
  if (!(err instanceof Error)) {
    return JSON.stringify(err);
  }
  return `${err.stack ?? ''} ${inspect(err, { depth: 8 })} ${JSON.stringify(err)}`;
}
