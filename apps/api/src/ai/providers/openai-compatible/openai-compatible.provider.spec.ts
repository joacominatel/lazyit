import { AiProviderError } from '../ai-provider.error';
import { AiModelListService } from '../ai-model-list.service';
import {
  captureLogs,
  chatModelFor,
  dumpError,
  jsonResponse,
  providerConfig,
  scriptedFetch,
  SECRET_KEY,
  sseResponse,
  stepRequest,
} from '../provider.harness-spec';

const config = providerConfig({
  provider: 'openai-compatible',
  model: 'qwen3-coder',
  baseUrl: 'https://llm.example.lan/v1',
  providerOptions: { temperature: 0.2 },
  effort: 'high',
});

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    data: {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'qwen3-coder',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    },
  };
}

function usageChunk(usage: Record<string, unknown>) {
  return {
    data: {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'qwen3-coder',
      choices: [],
      usage,
    },
  };
}

function compatError(status: number, message: string) {
  return () =>
    jsonResponse(status, {
      error: { message, type: 'BadRequestError', code: status },
    });
}

describe('OpenAI-compatible provider through ChatModelPort', () => {
  it('runs a text step against the configured base URL, with usage, the temperature extra and no effort', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        sseResponse([
          chunk({ role: 'assistant', content: 'Two ' }),
          chunk({ content: 'laptops.' }),
          chunk({}, 'stop'),
          usageChunk({
            prompt_tokens: 40,
            completion_tokens: 6,
            total_tokens: 46,
            prompt_tokens_details: { cached_tokens: 32 },
          }),
          'data: [DONE]\n\n',
        ]),
    ]);
    const deltas: string[] = [];

    const result = await chatModelFor(config, fetch).step(
      stepRequest(config, { onTextDelta: (t) => deltas.push(t) }),
    );

    expect(deltas.join('')).toBe('Two laptops.');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 6,
      cachedInputTokens: 32,
    });

    const [request] = requests;
    expect(request.url).toBe('https://llm.example.lan/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    const body = request.body!;
    expect(body).toMatchObject({
      model: 'qwen3-coder',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 1024,
      tool_choice: 'auto',
    });
    expect(body).not.toHaveProperty('reasoning_effort');
    // Chat Completions tools are loose by default, and a local server may reject an unknown flag (#1403).
    const [tool] = body.tools as Array<{ function: Record<string, unknown> }>;
    expect(tool.function).toMatchObject({ name: 'lazyit_search' });
    expect(tool.function).not.toHaveProperty('strict');
    expect((body.messages as Array<{ role: string }>)[0]).toMatchObject({
      role: 'system',
      content: 'frozen system prompt',
    });
  });

  it('runs a tool-call step', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lazyit_search', arguments: '' },
              },
            ],
          }),
          chunk({
            tool_calls: [
              { index: 0, function: { arguments: '{"query":"MacBook"}' } },
            ],
          }),
          chunk({}, 'tool_calls'),
          usageChunk({ prompt_tokens: 12, completion_tokens: 9 }),
          'data: [DONE]\n\n',
        ]),
    ]);

    const result = await chatModelFor(config, fetch).step(stepRequest(config));

    expect(requests).toHaveLength(1);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      {
        toolCallId: 'call_1',
        toolName: 'lazyit_search',
        input: { query: 'MacBook' },
      },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 9 });
  });

  it('sends no Authorization header when no key is configured (a local server)', async () => {
    const { fetch, requests } = scriptedFetch([
      () => sseResponse([chunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']),
    ]);
    const keyless = { ...config, apiKey: null };

    await chatModelFor(keyless, fetch).step(stepRequest(keyless));

    expect(requests[0].headers).not.toHaveProperty('authorization');
  });

  it('refuses a configuration without a base URL before any I/O', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const noBase = { ...config, baseUrl: null };

    await expect(
      chatModelFor(noBase, fetch).step(stepRequest(noBase)),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['PROVIDER_AUTH', compatError(401, 'Invalid token')],
    ['PROVIDER_RATE_LIMIT', compatError(429, 'Too many requests')],
    [
      'CONTEXT_LIMIT',
      compatError(
        400,
        "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
      ),
    ],
    ['PROVIDER_BAD_REQUEST', compatError(400, 'model "nope" not found')],
    ['PROVIDER_UNAVAILABLE', compatError(502, 'Bad gateway')],
  ])(
    'normalizes an upstream error into %s, without the key or the body',
    async (code, responder) => {
      const { fetch } = scriptedFetch([responder]);
      let caught: unknown;

      const logs = await captureLogs(async () => {
        try {
          await chatModelFor(config, fetch).step(stepRequest(config));
        } catch (err) {
          caught = err;
          throw err;
        }
      });

      expect(caught).toBeInstanceOf(AiProviderError);
      expect(caught).toMatchObject({ code });
      const dump = dumpError(caught);
      expect(dump).not.toContain(SECRET_KEY);
      expect(dump).not.toContain('frozen system prompt');
      expect(logs).not.toContain(SECRET_KEY);
      expect(logs).not.toContain('frozen system prompt');
    },
  );

  it('lists models from {baseUrl}/models', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        jsonResponse(200, {
          object: 'list',
          data: [{ id: 'qwen3-coder' }, { id: 'llama-4-scout' }],
        }),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    await expect(service.listModels(config)).resolves.toEqual([
      { id: 'llama-4-scout', label: null },
      { id: 'qwen3-coder', label: null },
    ]);
    expect(requests[0].url).toBe('https://llm.example.lan/v1/models');
  });
});
