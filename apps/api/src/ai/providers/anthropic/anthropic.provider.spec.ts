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
  provider: 'anthropic',
  model: 'claude-opus-5',
  effort: 'high',
});

function messageStart(usage: Record<string, number>) {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  };
}

function messageEnd(stopReason: string, outputTokens: number) {
  return [
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function textStream(text: string[]) {
  return sseResponse([
    messageStart({
      input_tokens: 12,
      output_tokens: 1,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    }),
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    ...text.map((t) => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: t },
      },
    })),
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    ...messageEnd('end_turn', 7),
  ]);
}

function toolStream() {
  return sseResponse([
    messageStart({ input_tokens: 20, output_tokens: 1 }),
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Search first.' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'SIG-ANTHROPIC' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lazyit_search',
          input: {},
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"query":"MacBook"}',
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    ...messageEnd('tool_use', 30),
  ]);
}

function anthropicError(status: number, type: string, message: string) {
  return (headers: Record<string, string> = {}) =>
    () =>
      jsonResponse(
        status,
        { type: 'error', error: { type, message } },
        headers,
      );
}

describe('Anthropic provider through ChatModelPort', () => {
  it('sends a conversation’s own model and effort (#1373) in place of the instance ones, for that call only', async () => {
    const { fetch, requests } = scriptedFetch([
      () => textStream(['ok']),
      () => textStream(['ok']),
    ]);
    const port = chatModelFor(config, fetch);
    await port.step(
      stepRequest(config, {
        model: { provider: 'anthropic', modelId: 'claude-haiku-5' },
        effort: 'low',
      }),
    );
    await port.step(stepRequest(config));
    const [chosen, instance] = requests.map((r) => r.body!);
    expect(chosen.model).toBe('claude-haiku-5');
    expect(JSON.stringify(chosen)).toContain('"effort":"low"');
    expect(JSON.stringify(chosen)).not.toContain('"effort":"high"');
    expect(instance.model).toBe('claude-opus-5');
    expect(JSON.stringify(instance)).toContain('"effort":"high"');
  });

  it('runs a text step: streamed deltas, usage with cache reads, the key header and the request knobs', async () => {
    const { fetch, requests } = scriptedFetch([
      () => textStream(['The MacBook ', 'is assigned.']),
    ]);
    const deltas: string[] = [];

    const result = await chatModelFor(config, fetch).step(
      stepRequest(config, { onTextDelta: (t) => deltas.push(t) }),
    );

    expect(deltas.join('')).toBe('The MacBook is assigned.');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({
      inputTokens: 812,
      outputTokens: 7,
      cachedInputTokens: 800,
    });
    expect(
      (result.responseMessages as Array<{ role: string }>).map((m) => m.role),
    ).toEqual(['assistant']);

    const [request] = requests;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['x-api-key']).toBe(SECRET_KEY);
    const body = request.body!;
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(1024);
    // Cache breakpoints: the end of the frozen system prompt, plus the request-level automatic one.
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'frozen system prompt',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body)).toContain('"effort":"high"');
    // Never a sampling parameter: current Anthropic models reject them.
    expect(body).not.toHaveProperty('temperature');
    expect(body.tools).toEqual([
      expect.objectContaining({ name: 'lazyit_search' }),
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('runs a tool-call step: the call is returned, not executed, and the signed thinking is kept for replay', async () => {
    const { fetch, requests } = scriptedFetch([() => toolStream()]);

    const result = await chatModelFor(config, fetch).step(stepRequest(config));

    expect(requests).toHaveLength(1);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([
      {
        toolCallId: 'toolu_1',
        toolName: 'lazyit_search',
        input: { query: 'MacBook' },
      },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 30 });
    expect(JSON.stringify(result.responseMessages)).toContain('SIG-ANTHROPIC');
  });

  it('replays the signed thinking from persisted messages on the next step', async () => {
    const { fetch, requests } = scriptedFetch([
      () => toolStream(),
      () => textStream(['No MacBook found.']),
    ]);
    const port = chatModelFor(config, fetch);
    const history: unknown[] = [port.userMessage('Find the MacBook')];

    const first = await port.step(stepRequest(config, { messages: history }));
    // Persisted and reloaded as the jsonb column will, then answered with the loop's tool message.
    history.push(
      ...(JSON.parse(JSON.stringify(first.responseMessages)) as unknown[]),
      port.toolResultsMessage([
        {
          toolCallId: first.toolCalls[0].toolCallId,
          toolName: 'lazyit_search',
          output: { items: [] },
          isError: false,
        },
      ]),
    );
    await port.step(stepRequest(config, { messages: history }));

    const replayed = requests[1].body!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(replayed.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(replayed[1].content[0]).toEqual({
      type: 'thinking',
      thinking: 'Search first.',
      signature: 'SIG-ANTHROPIC',
    });
    expect(replayed[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
    });
    expect(replayed[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
    });
  });

  it("keeps the tools declared on a toolChoice 'none' step and sends Anthropic's native none", async () => {
    // The SDK alone would drop `tools`, which Anthropic rejects once the history holds tool_use blocks
    // and which would change the frozen tools prefix.
    const { fetch, requests } = scriptedFetch([
      () => textStream(['Step one.']),
      () => textStream(['Summary.']),
    ]);
    const port = chatModelFor(config, fetch);

    await port.step(stepRequest(config));
    const result = await port.step(stepRequest(config, { toolChoice: 'none' }));

    expect(result.finishReason).toBe('stop');
    expect(requests[1].body!.tool_choice).toEqual({ type: 'none' });
    expect(requests[1].body!.tools).toEqual(requests[0].body!.tools);
    expect(requests[1].body!.system).toEqual(requests[0].body!.system);
  });

  it.each([
    [
      'PROVIDER_AUTH',
      anthropicError(401, 'authentication_error', 'invalid x-api-key')(),
      undefined,
    ],
    [
      'PROVIDER_RATE_LIMIT',
      anthropicError(
        429,
        'rate_limit_error',
        'slow down',
      )({
        'retry-after': '7',
      }),
      7,
    ],
    [
      'CONTEXT_LIMIT',
      anthropicError(
        400,
        'invalid_request_error',
        'prompt is too long: 1000001 tokens > 1000000 maximum',
      )(),
      undefined,
    ],
    [
      'PROVIDER_BAD_REQUEST',
      anthropicError(400, 'invalid_request_error', 'tools.0: bad schema')(),
      undefined,
    ],
    [
      'PROVIDER_UNAVAILABLE',
      anthropicError(529, 'overloaded_error', 'Overloaded')(),
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
      expect(dump).not.toContain('Overloaded');
      expect(logs).not.toContain(SECRET_KEY);
      // The SDK's default error handler would print the raw error, request body (the prompt) included.
      expect(logs).not.toContain('frozen system prompt');
      expect(logs).not.toContain('Find the MacBook');
    },
  );

  it('normalizes an error event inside a started stream', async () => {
    const { fetch } = scriptedFetch([
      () =>
        sseResponse([
          messageStart({ input_tokens: 5, output_tokens: 1 }),
          {
            event: 'error',
            data: {
              type: 'error',
              error: { type: 'overloaded_error', message: 'Overloaded' },
            },
          },
        ]),
    ]);

    await expect(
      chatModelFor(config, fetch).step(stepRequest(config)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('lists models through the guarded fetch, with the key header and without echoing the body', async () => {
    const { fetch, requests } = scriptedFetch([
      () =>
        jsonResponse(200, {
          data: [
            { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
            { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          ],
          has_more: false,
        }),
    ]);
    const service = new AiModelListService({
      fetchFactory: () => fetch,
    });

    await expect(service.listModels(config)).resolves.toEqual([
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    ]);
    expect(requests[0].url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000',
    );
    expect(requests[0].headers['x-api-key']).toBe(SECRET_KEY);
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
  });
});
