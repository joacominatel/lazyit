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
  provider: 'openai',
  model: 'gpt-6-sol',
  effort: 'medium',
});

const created = {
  data: {
    type: 'response.created',
    response: { id: 'resp_1', created_at: 1758600000, model: 'gpt-6-sol' },
  },
};

function completed(usage: Record<string, unknown>) {
  return { data: { type: 'response.completed', response: { usage } } };
}

function textStream(text: string[]) {
  return sseResponse([
    created,
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
    },
    ...text.map((delta) => ({
      data: {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        delta,
      },
    })),
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_1' },
      },
    },
    completed({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 60 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
    }),
  ]);
}

function toolStream() {
  return sseResponse([
    created,
    {
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: null },
      },
    },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'ENC-OPENAI',
        },
      },
    },
    {
      data: {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lazyit_search',
          arguments: '',
        },
      },
    },
    {
      data: {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"query":"MacBook"}',
      },
    },
    {
      data: {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lazyit_search',
          arguments: '{"query":"MacBook"}',
          status: 'completed',
        },
      },
    },
    completed({ input_tokens: 30, output_tokens: 12 }),
  ]);
}

function openaiError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) {
  return () =>
    jsonResponse(
      status,
      { error: { message, type: 'invalid_request_error', code } },
      headers,
    );
}

describe('OpenAI provider through ChatModelPort', () => {
  it('runs a text step on the Responses API with store: false, the effort and the Bearer key', async () => {
    const { fetch, requests } = scriptedFetch([
      () => textStream(['Two ', 'laptops.']),
    ]);
    const deltas: string[] = [];

    const result = await chatModelFor(config, fetch).step(
      stepRequest(config, { onTextDelta: (t) => deltas.push(t) }),
    );

    expect(deltas.join('')).toBe('Two laptops.');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 60,
      reasoningTokens: 5,
    });

    const [request] = requests;
    expect(request.url).toBe('https://api.openai.com/v1/responses');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    const body = request.body!;
    expect(body.model).toBe('gpt-6-sol');
    // OpenAI keeps no copy; reasoning comes back encrypted for stateless replay.
    expect(body.store).toBe(false);
    expect(body.include).toEqual(
      expect.arrayContaining(['reasoning.encrypted_content']),
    );
    expect(body.reasoning).toMatchObject({ effort: 'medium' });
    expect(body.max_output_tokens).toBe(1024);
    expect(JSON.stringify(body)).toContain('frozen system prompt');
    expect(body.tool_choice).toBe('auto');
  });

  it('runs a tool-call step and keeps the encrypted reasoning for replay', async () => {
    const { fetch, requests } = scriptedFetch([() => toolStream()]);

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
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    expect(JSON.stringify(result.responseMessages)).toContain('ENC-OPENAI');
  });

  it("keeps the tools declared on a toolChoice 'none' step", async () => {
    const { fetch, requests } = scriptedFetch([() => textStream(['Done.'])]);

    await chatModelFor(config, fetch).step(
      stepRequest(config, { toolChoice: 'none' }),
    );

    expect(requests[0].body!.tool_choice).toBe('none');
    expect(requests[0].body!.tools).toEqual([
      expect.objectContaining({ name: 'lazyit_search' }),
    ]);
  });

  it('sends every lazyit tool with strict: false — the Responses API default is strict (#1403)', async () => {
    // Omitted, OpenAI runs the tool strict and the model fills EVERY property of its input (a form's
    // options, optionsFrom, min and max on every field, whatever its kind): the request_input failures.
    const { fetch, requests } = scriptedFetch([() => textStream(['Done.'])]);

    await chatModelFor(config, fetch).step(stepRequest(config));

    const tools = requests[0].body!.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool).toMatchObject({ type: 'function', strict: false });
    }
  });

  it.each([
    [
      'PROVIDER_AUTH',
      // OpenAI echoes the key it rejected in the error message: it must not survive the wrapping.
      openaiError(
        401,
        'invalid_api_key',
        `Incorrect API key provided: ${SECRET_KEY}.`,
      ),
      undefined,
    ],
    [
      'PROVIDER_RATE_LIMIT',
      openaiError(429, 'rate_limit_exceeded', 'Rate limit reached', {
        'retry-after-ms': '1500',
      }),
      2,
    ],
    [
      'CONTEXT_LIMIT',
      openaiError(
        400,
        'context_length_exceeded',
        'Your input exceeds the context window of this model.',
      ),
      undefined,
    ],
    [
      'PROVIDER_BAD_REQUEST',
      openaiError(404, 'model_not_found', 'The model does not exist'),
      undefined,
    ],
    [
      'PROVIDER_UNAVAILABLE',
      openaiError(503, 'server_error', 'The server is overloaded'),
      undefined,
    ],
  ])(
    'normalizes an upstream error into %s, without the key or the body',
    async (code, responder, retryAfterSec) => {
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
      expect((caught as AiProviderError).retryAfterSec).toBe(retryAfterSec);
      const dump = dumpError(caught);
      expect(dump).not.toContain(SECRET_KEY);
      expect(dump).not.toContain('frozen system prompt');
      expect(logs).not.toContain(SECRET_KEY);
      expect(logs).not.toContain('frozen system prompt');
    },
  );

  it('lists chat models only, through the guarded fetch', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        jsonResponse(200, {
          object: 'list',
          data: [
            { id: 'gpt-6-sol', object: 'model' },
            { id: 'text-embedding-4-large', object: 'model' },
            { id: 'gpt-6-luna', object: 'model' },
            { id: 'whisper-2', object: 'model' },
          ],
        }),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    await expect(service.listModels(config)).resolves.toEqual([
      { id: 'gpt-6-luna', label: null },
      { id: 'gpt-6-sol', label: null },
    ]);
    expect(requests[0].url).toBe('https://api.openai.com/v1/models');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('classifies a failed model listing by status, without echoing the upstream body', async () => {
    const { fetch } = scriptedFetch([
      openaiError(401, 'invalid_api_key', 'upstream secret detail'),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    const error = await service.listModels(config).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(dumpError(error)).not.toContain('upstream secret detail');
  });
});
