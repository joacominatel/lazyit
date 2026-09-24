import {
  AiModelListService,
  MODEL_LIST_TIMEOUT_MS,
} from './ai-model-list.service';
import { providerConfig } from './provider.harness-spec';
import type { FetchLike } from './provider.types';

/**
 * A model listing has its own short deadline (not the 600 s model-step budget), covering both the
 * headers and the body, and honours the caller's abort signal.
 */

const config = providerConfig({ provider: 'openai', model: 'gpt-6-sol' });

function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), {
    name: 'AbortError',
  });
}

/** An upstream that never answers; the request dies only when its signal aborts. */
const silentHeaders: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(abortError()));
  });

/** An upstream that sends headers, then never finishes the body (the real transport errors it on abort). */
const silentBody: FetchLike = (_input, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
          init?.signal?.addEventListener('abort', () =>
            controller.error(abortError()),
          );
        },
      }),
      { status: 200 },
    ),
  );

function serviceWith(fetch: FetchLike, timeoutMs = 50): AiModelListService {
  return new AiModelListService({
    fetchFactory: () => fetch,
    modelListTimeoutMs: timeoutMs,
  });
}

describe('AiModelListService deadline', () => {
  it('defaults to a short budget, far below the model-step deadline', () => {
    expect(MODEL_LIST_TIMEOUT_MS).toBe(15_000);
  });

  it('gives up on an upstream that never sends headers: PROVIDER_UNAVAILABLE', async () => {
    const started = Date.now();

    await expect(
      serviceWith(silentHeaders).listModels(config),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a body that never ends: PROVIDER_UNAVAILABLE', async () => {
    await expect(
      serviceWith(silentBody).listModels(config),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('stops when the caller aborts: CANCELLED', async () => {
    const controller = new AbortController();
    const pending = serviceWith(silentHeaders, 10_000).listModels(
      config,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
