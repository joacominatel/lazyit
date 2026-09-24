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
  provider: 'google',
  model: 'gemini-3.8-flash',
  effort: 'low',
});

function chunk(
  parts: Array<Record<string, unknown>>,
  finishReason?: string,
  usageMetadata?: Record<string, number>,
) {
  return {
    data: {
      candidates: [
        {
          content: { role: 'model', parts },
          ...(finishReason ? { finishReason } : {}),
        },
      ],
      ...(usageMetadata ? { usageMetadata } : {}),
    },
  };
}

function googleError(status: number, grpcStatus: string, message: string) {
  return () =>
    jsonResponse(status, {
      error: { code: status, message, status: grpcStatus },
    });
}

describe('Google Gemini provider through ChatModelPort', () => {
  it('runs a text step: deltas, usage with cached and thought tokens, the key header and the thinking level', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        sseResponse([
          chunk([{ text: 'The MacBook ' }]),
          chunk([{ text: 'is assigned.' }], 'STOP', {
            promptTokenCount: 50,
            cachedContentTokenCount: 30,
            candidatesTokenCount: 8,
            thoughtsTokenCount: 4,
            totalTokenCount: 62,
          }),
        ]),
    ]);
    const deltas: string[] = [];

    const result = await chatModelFor(config, fetch).step(
      stepRequest(config, { onTextDelta: (t) => deltas.push(t) }),
    );

    expect(deltas.join('')).toBe('The MacBook is assigned.');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 50,
      cachedInputTokens: 30,
      reasoningTokens: 4,
    });
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(8);

    const [request] = requests;
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
    );
    expect(request.headers['x-goog-api-key']).toBe(SECRET_KEY);
    const body = request.body!;
    expect(JSON.stringify(body.systemInstruction)).toContain(
      'frozen system prompt',
    );
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingLevel: 'low' },
    });
    expect(body.generationConfig).not.toHaveProperty('temperature');
  });

  it('runs a tool-call step and keeps the thought signature for replay', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        sseResponse([
          chunk(
            [
              { text: 'Search first.', thought: true },
              {
                functionCall: {
                  name: 'lazyit_search',
                  args: { query: 'MacBook' },
                },
                thoughtSignature: 'SIG-GEMINI',
              },
            ],
            'STOP',
            {
              promptTokenCount: 10,
              candidatesTokenCount: 20,
              totalTokenCount: 30,
            },
          ),
        ]),
    ]);

    const result = await chatModelFor(config, fetch).step(stepRequest(config));

    expect(requests).toHaveLength(1);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'lazyit_search',
        input: { query: 'MacBook' },
      }),
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 10 });
    expect(JSON.stringify(result.responseMessages)).toContain('SIG-GEMINI');
  });

  it("keeps the tools declared on a toolChoice 'none' step", async () => {
    const { fetch, requests } = scriptedFetch([
      () => sseResponse([chunk([{ text: 'Done.' }], 'STOP')]),
    ]);

    await chatModelFor(config, fetch).step(
      stepRequest(config, { toolChoice: 'none' }),
    );

    expect(requests[0].body!.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
    expect(JSON.stringify(requests[0].body!.tools)).toContain('lazyit_search');
  });

  it.each([
    [
      'PROVIDER_AUTH',
      googleError(
        400,
        'INVALID_ARGUMENT',
        'API key not valid. Please pass a valid API key.',
      ),
    ],
    [
      'PROVIDER_AUTH',
      googleError(403, 'PERMISSION_DENIED', 'Permission denied'),
    ],
    [
      'PROVIDER_RATE_LIMIT',
      googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'),
    ],
    [
      'CONTEXT_LIMIT',
      googleError(
        400,
        'INVALID_ARGUMENT',
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ],
    [
      'PROVIDER_BAD_REQUEST',
      googleError(404, 'NOT_FOUND', 'models/gemini-9 is not found'),
    ],
    [
      'PROVIDER_UNAVAILABLE',
      googleError(503, 'UNAVAILABLE', 'The model is overloaded'),
    ],
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

  it('lists only generateContent models, with the key header', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        jsonResponse(200, {
          models: [
            {
              name: 'models/gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            {
              name: 'models/text-embedding-005',
              displayName: 'Embedding',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    await expect(service.listModels(config)).resolves.toEqual([
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    ]);
    expect(requests[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    );
    expect(requests[0].headers['x-goog-api-key']).toBe(SECRET_KEY);
  });

  it("classifies a model listing refused for a bad key (Gemini's 400) as PROVIDER_AUTH", async () => {
    const { fetch } = scriptedFetch([
      googleError(400, 'INVALID_ARGUMENT', 'API key not valid.'),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    await expect(service.listModels(config)).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
  });
});
