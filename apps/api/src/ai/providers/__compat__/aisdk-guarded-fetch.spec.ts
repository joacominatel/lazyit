/**
 * Compatibility regression (epic #1315 W1-B item e): `guardedFetch` works as the AI SDK's `fetch`
 * option, streaming body included, and an LLM stream outliving the idle budget survives only when the
 * caller passes an explicit total `deadlineMs`. Without one, the node transport's deadline falls back
 * to the idle `timeoutMs` (30 s by default) and cuts a long generation mid-body — which is why the
 * provider layer must always pass both (provider-and-runtime.md §9.2).
 *
 * The real pinning node transport is used against a local server. The guard itself (correctly)
 * refuses loopback, so the DNS lookup reports a public address and the transport is re-pinned to
 * 127.0.0.1 underneath it; validation, header handling and body streaming are the production path.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, streamText } from 'ai';

import {
  createNodeTransport,
  guardedFetch,
} from '../../../common/egress/egress-guard';
import type {
  DnsLookup,
  EgressTransport,
  GuardedFetchOptions,
} from '../../../common/egress/types';

type FetchFn = typeof globalThis.fetch;

const TOKENS = ['The ', 'MacBook ', 'is ', 'assigned ', 'to ', 'Ana.'];
const GAP_MS = 80; // below the idle timeout; the whole stream (~480 ms) is above it
const IDLE_TIMEOUT_MS = 250;

const publicLookup: DnsLookup = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

/** The shape the provider layer's `provider-fetch.ts` adapter takes: the SDK's fetch over guardedFetch. */
function providerFetch(opts: GuardedFetchOptions): FetchFn {
  return (input, init) =>
    guardedFetch(input instanceof Request ? input.url : input, init, opts);
}

function chunk(
  delta: Record<string, string>,
  finishReason: string | null = null,
): string {
  const body = {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-model',
  };
  return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

describe('guardedFetch as the AI SDK fetch (streaming, long deadline)', () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{
    url?: string;
    authorization?: string;
    body: Record<string, unknown>;
    closedBeforeEnd: boolean;
  }> = [];

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const entry = {
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
          closedBeforeEnd: false,
        };
        seen.push(entry);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.on('error', () => {});
        res.on('close', () => {
          entry.closedBeforeEnd = !res.writableEnded;
        });
        let i = 0;
        const tick = (): void => {
          if (res.destroyed) {
            return;
          }
          if (i < TOKENS.length) {
            res.write(
              chunk(
                i === 0
                  ? { role: 'assistant', content: TOKENS[i] }
                  : { content: TOKENS[i] },
              ),
            );
            i += 1;
            setTimeout(tick, GAP_MS);
          } else {
            res.write(chunk({}, 'stop'));
            res.end('data: [DONE]\n\n');
          }
        };
        tick();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  function model(
    opts: Omit<
      GuardedFetchOptions,
      'transport' | 'lookup' | 'allowedProtocols'
    >,
  ) {
    const node = createNodeTransport();
    const loopbackPinned: EgressTransport = (url, req) =>
      node(url, { ...req, pin: { address: '127.0.0.1', family: 4 } });
    const fetch = providerFetch({
      ...opts,
      lookup: publicLookup,
      transport: loopbackPinned,
      allowedProtocols: ['http:'],
    });
    return createOpenAICompatible({
      name: 'local',
      baseURL: `http://llm.example:${port}/v1`,
      apiKey: 'test-key',
      includeUsage: true,
      fetch,
    })('local-model');
  }

  it('streams a generation longer than the idle timeout when deadlineMs is explicit', async () => {
    const startedAt = Date.now();
    const result = streamText({
      model: model({ timeoutMs: IDLE_TIMEOUT_MS, deadlineMs: 10_000 }),
      prompt: 'Who has the MacBook?',
      maxRetries: 0,
    });

    const deltas: string[] = [];
    for await (const delta of result.textStream) {
      deltas.push(delta);
    }

    expect(deltas.join('')).toBe(TOKENS.join(''));
    expect(deltas.length).toBeGreaterThan(1); // arrived incrementally, not buffered
    expect(Date.now() - startedAt).toBeGreaterThan(IDLE_TIMEOUT_MS);

    const request = seen[seen.length - 1];
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.authorization).toBe('Bearer test-key'); // SDK headers pass through the guard
    expect(request.body).toMatchObject({ model: 'local-model', stream: true });
    expect(request.closedBeforeEnd).toBe(false);
  });

  it('cuts the same stream mid-body when deadlineMs is omitted (it falls back to the idle timeout)', async () => {
    const result = streamText({
      model: model({ timeoutMs: IDLE_TIMEOUT_MS }),
      prompt: 'Who has the MacBook?',
      maxRetries: 0,
    });

    const deltas: string[] = [];
    let failure: unknown;
    try {
      for await (const delta of result.textStream) {
        deltas.push(delta);
      }
    } catch (err) {
      failure = err;
    }

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).not.toBe(TOKENS.join(''));
    // A mid-body cut surfaces as the SDK's APICallError wrapping a bare socket "aborted": the
    // EgressError reason ('deadline-exceeded') does not survive, so error classification cannot rely
    // on it once the response has started.
    expect(APICallError.isInstance(failure)).toBe(true);
    expect((failure as APICallError).cause).toMatchObject({
      message: 'aborted',
    });
  });

  it('forwards the SDK abortSignal to the socket, so cancelling a run closes the upstream stream', async () => {
    const controller = new AbortController();
    const result = streamText({
      model: model({ timeoutMs: IDLE_TIMEOUT_MS, deadlineMs: 10_000 }),
      prompt: 'Who has the MacBook?',
      maxRetries: 0,
      abortSignal: controller.signal,
    });

    const deltas: string[] = [];
    try {
      for await (const delta of result.textStream) {
        deltas.push(delta);
        if (deltas.length === 2) {
          controller.abort();
        }
      }
    } catch {
      // The abort surfaces as an AbortError; what matters is the upstream socket below.
    }

    expect(deltas).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, GAP_MS * 2));
    expect(seen[seen.length - 1].closedBeforeEnd).toBe(true);
  });
});
