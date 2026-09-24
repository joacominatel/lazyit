// The real settings module pulls the generated Prisma client, which this unit spec does not need: the
// module tests below override it with a fake that binds (or not) AI_SETTINGS_READER.
jest.mock('../settings/ai-settings.module', () => {
  const { Module } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  class AiSettingsModule {}
  Module({})(AiSettingsModule);
  return { AiSettingsModule };
});

import { AsyncLocalStorage } from 'node:async_hooks';

import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import {
  registerTelemetry,
  simulateReadableStream,
  type ModelMessage,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { AI_SETTINGS_READER } from '../core/ports/ai-settings.port';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
} from '../core/ports/chat-model.port';
import { AiModelListService } from './ai-model-list.service';
import { AiProvidersModule } from './ai-providers.module';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiSdkChatModel } from './aisdk-chat-model';
import { anthropicProvider } from './anthropic/anthropic.provider';
import type { FetchLike } from './provider.types';
import {
  captureLogs,
  chatModelFor,
  providerConfig,
  readerFor,
  scriptedFetch,
  sseResponse,
  stepRequest,
} from './provider.harness-spec';

/**
 * The port's own contract (provider-and-runtime.md §6.1–§6.4), driven by the SDK's `MockLanguageModelV4`
 * in place of the provider model: one step per call, tools never executed, the settings reader as the
 * source of the key, cancellation, and the replayable message shapes the runtime persists.
 */

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer P>
    ? P
    : never;

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textParts(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage,
    },
  ];
}

function mockModel(
  steps: StreamPart[][],
  extra: { chunkDelayInMs?: number; warnings?: unknown[] } = {},
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({
      stream: simulateReadableStream({
        chunks: extra.warnings
          ? [
              { type: 'stream-start', warnings: extra.warnings } as StreamPart,
              ...chunks,
            ]
          : chunks,
        chunkDelayInMs: extra.chunkDelayInMs,
      }),
    })),
  });
}

const config = providerConfig();

describe('AiSdkChatModel (ChatModelPort)', () => {
  let createModel: jest.SpyInstance;

  afterEach(() => {
    createModel?.mockRestore();
  });

  function useModel(model: MockLanguageModelV4): void {
    createModel = jest
      .spyOn(anthropicProvider, 'createModel')
      .mockReturnValue(model);
  }

  it('runs exactly one model step and returns the proposed tool calls without executing anything', async () => {
    const model = mockModel([
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Looking.' },
        { type: 'text-end', id: 't' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'lazyit_search',
          input: '{"query":"MacBook"}',
        },
        {
          type: 'tool-call',
          toolCallId: 'c2',
          toolName: 'not_in_toolset',
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
        },
      ],
      textParts('SECOND STEP — must never be requested'),
    ]);
    useModel(model);
    const { fetch } = scriptedFetch([]);

    const result = await chatModelFor(config, fetch).step(stepRequest(config));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(result.finishReason).toBe('tool-calls');
    // An unknown tool is still reported: the loop validates every call (W1-B finding 2).
    expect(result.toolCalls).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'lazyit_search',
        input: { query: 'MacBook' },
      },
      { toolCallId: 'c2', toolName: 'not_in_toolset', input: {} },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    // Only the assistant message: not the SDK's own tool-error message for the unknown tool, which the
    // loop answers itself in its single tool message.
    const messages = result.responseMessages as ModelMessage[];
    expect(messages.map((m) => m.role)).toEqual(['assistant']);

    const call = model.doStreamCalls[0];
    expect(call.tools?.map((t) => t.name)).toEqual(['lazyit_search']);
    expect(call.toolChoice).toEqual({ type: 'auto' });
    expect(call.maxOutputTokens).toBe(1024);
    expect(call.prompt[0]).toMatchObject({
      role: 'system',
      content: 'frozen system prompt',
    });
  });

  it('reports invalid calls as they are: a raw-string input and a name that is not an own tool', async () => {
    // The contract W2-3 relies on: every call comes back, unvalidated. The input of a call whose JSON
    // does not parse is the raw string, and a name such as `constructor` must be looked up with an
    // own-property check. The loop answers every one of them in its single tool message.
    useModel(
      mockModel([
        [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'lazyit_search',
            input: '{bad',
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'constructor',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'x' },
            usage,
          },
        ],
      ]),
    );

    const result = await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config),
    );

    expect(result.toolCalls).toEqual([
      { toolCallId: 'c1', toolName: 'lazyit_search', input: '{bad' },
      { toolCallId: 'c2', toolName: 'constructor', input: {} },
    ]);
    expect(
      (result.responseMessages as ModelMessage[]).map((m) => m.role),
    ).toEqual(['assistant']);
  });

  it('replays persisted messages and the tool-result message it built, through a JSON round trip', async () => {
    const model = mockModel([textParts('No MacBook found.')]);
    useModel(model);
    const port = chatModelFor(config, scriptedFetch([]).fetch);

    const history = JSON.parse(
      JSON.stringify([
        port.userMessage('Find the MacBook'),
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'lazyit_search',
              input: { query: 'MacBook' },
            },
          ],
        },
        port.toolResultsMessage([
          {
            toolCallId: 'c1',
            toolName: 'lazyit_search',
            output: { items: [] },
            isError: false,
          },
        ]),
      ]),
    ) as unknown[];

    const result = await port.step(stepRequest(config, { messages: history }));

    expect(result.finishReason).toBe('stop');
    const prompt = model.doStreamCalls[0].prompt;
    expect(prompt.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(prompt[3].content).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'c1',
        output: { type: 'json', value: { items: [] } },
      }),
    ]);
  });

  it('builds one tool message carrying every outcome, errors included', () => {
    const port = chatModelFor(config, scriptedFetch([]).fetch);

    expect(
      port.toolResultsMessage([
        {
          toolCallId: 'a',
          toolName: 'x',
          output: { ok: true },
          isError: false,
        },
        {
          toolCallId: 'b',
          toolName: 'y',
          output: { code: 'FORBIDDEN' },
          isError: true,
        },
        { toolCallId: 'c', toolName: 'z', output: 'plain', isError: false },
      ]),
    ).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a',
          toolName: 'x',
          output: { type: 'json', value: { ok: true } },
        },
        {
          type: 'tool-result',
          toolCallId: 'b',
          toolName: 'y',
          output: { type: 'error-json', value: { code: 'FORBIDDEN' } },
        },
        {
          type: 'tool-result',
          toolCallId: 'c',
          toolName: 'z',
          output: { type: 'text', value: 'plain' },
        },
      ],
    });
    expect(port.userMessage('hi')).toEqual({ role: 'user', content: 'hi' });
  });

  it('streams text deltas, and a failing listener does not fail the step', async () => {
    useModel(
      mockModel([
        [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'a' },
          { type: 'text-delta', id: 't', delta: 'b' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'x' },
            usage,
          },
        ],
      ]),
    );
    const seen: string[] = [];

    const result = await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config, {
        onTextDelta: (t) => {
          seen.push(t);
          throw new Error('bus down');
        },
      }),
    );

    expect(seen).toEqual(['a', 'b']);
    expect(result.finishReason).toBe('stop');
  });

  it('is cancelled by the abort signal mid-stream', async () => {
    useModel(
      mockModel([textParts('x').concat(textParts('y'))], {
        chunkDelayInMs: 30,
      }),
    );
    const controller = new AbortController();

    const pending = chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config, {
        abortSignal: controller.signal,
        onTextDelta: () => controller.abort(),
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails AI_DISABLED when no settings reader is bound yet, or it resolves no configuration', async () => {
    const { fetch, requests } = scriptedFetch([]);
    const unbound = new AiSdkChatModel(null, {
      fetchFactory: () => fetch,
    });
    const disabled = new AiSdkChatModel(readerFor(null), {
      fetchFactory: () => fetch,
    });

    await expect(unbound.step(stepRequest(config))).rejects.toMatchObject({
      code: 'AI_DISABLED',
    });
    await expect(disabled.step(stepRequest(config))).rejects.toMatchObject({
      code: 'AI_DISABLED',
    });
    expect(requests).toHaveLength(0);
  });

  it('reads the connection on every step, never caching it (the tester overrides it per call)', async () => {
    useModel(mockModel([textParts('one')]));
    const reader = readerFor(config);
    const resolve = jest
      .spyOn(reader, 'resolveProviderConfig')
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(null);
    const port = new AiSdkChatModel(reader, {
      fetchFactory: () => scriptedFetch([]).fetch,
    });

    await expect(port.step(stepRequest(config))).resolves.toMatchObject({
      finishReason: 'stop',
    });
    await expect(port.step(stepRequest(config))).rejects.toMatchObject({
      code: 'AI_DISABLED',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('a connection-test draft (scoped reader override) never bleeds into real runs', async () => {
    // The settings unit answers a draft through an AsyncLocalStorage override of the reader for one
    // call. The port must resolve the connection on every step, so the override applies to exactly the
    // step run inside it: not before, not after, not to a real run interleaved with it.
    const saved = providerConfig({
      provider: 'openai-compatible',
      model: 'qwen3-coder',
      baseUrl: 'https://saved.example/v1',
      apiKey: 'sk-SAVED',
    });
    const draft = {
      ...saved,
      baseUrl: 'https://draft.example/v1',
      apiKey: 'sk-DRAFT',
    };
    const override = new AsyncLocalStorage<typeof draft>();
    const reader = {
      getSettings: () => Promise.reject(new Error('not used')),
      resolveProviderConfig: () =>
        Promise.resolve(override.getStore() ?? saved),
    };
    const seen: Array<{ url: string; authorization?: string }> = [];
    const fetch: FetchLike = (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        authorization:
          new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return Promise.resolve(
        sseResponse([
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'qwen3-coder',
              choices: [
                { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
              ],
            },
          },
          'data: [DONE]\n\n',
        ]),
      );
    };
    const port = new AiSdkChatModel(reader, {
      fetchFactory: () => fetch,
      maxRetries: 0,
    });

    await port.step(stepRequest(saved));
    await Promise.all([
      override.run(draft, () => port.step(stepRequest(draft))),
      port.step(stepRequest(saved)),
    ]);
    await port.step(stepRequest(saved));

    expect(seen.map((r) => [new URL(r.url).host, r.authorization])).toEqual([
      ['saved.example', 'Bearer sk-SAVED'],
      ['draft.example', 'Bearer sk-DRAFT'],
      ['saved.example', 'Bearer sk-SAVED'],
      ['saved.example', 'Bearer sk-SAVED'],
    ]);
  });

  it('never sends the key to a provider other than the configured one', async () => {
    const { fetch, requests } = scriptedFetch([]);

    await expect(
      chatModelFor(config, fetch).step(
        stepRequest(config, {
          model: { provider: 'openai', modelId: 'gpt-6-sol' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONVERSATION_READ_ONLY' });
    expect(requests).toHaveLength(0);
  });

  it('fails PROVIDER_AUTH without a key before any I/O, even when the SDK env fallback is set', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-the-environment';
    try {
      const { fetch, requests } = scriptedFetch([]);
      const keyless = { ...config, apiKey: null };

      await expect(
        chatModelFor(keyless, fetch).step(stepRequest(keyless)),
      ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
      expect(requests).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });

  it('treats a provider kind written by a newer build as not configured', async () => {
    const unknown = { ...config, provider: 'bedrock' as never };

    await expect(
      chatModelFor(unknown, scriptedFetch([]).fetch).step(stepRequest(unknown)),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
  });

  it('never lets the SDK download a file URL from a message (it would bypass the egress guard)', async () => {
    const model = mockModel([textParts('never')]);
    useModel(model);
    const globalFetch = jest.spyOn(globalThis, 'fetch');

    try {
      await expect(
        chatModelFor(config, scriptedFetch([]).fetch).step(
          stepRequest(config, {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'file',
                    data: new URL('http://169.254.169.254/latest/meta-data'),
                    mediaType: 'image/png',
                  },
                ],
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'EGRESS_DENIED' });
      expect(globalFetch).not.toHaveBeenCalled();
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('keeps telemetry off even when an integration is registered (ADR-0031: no prompts to APM)', async () => {
    useModel(mockModel([textParts('ok')]));
    const integration = {
      onStart: jest.fn(),
      onStepStart: jest.fn(),
      onLanguageModelCallStart: jest.fn(),
      onLanguageModelCallEnd: jest.fn(),
      onFinish: jest.fn(),
    };
    registerTelemetry(integration);

    await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config),
    );

    for (const hook of Object.values(integration)) {
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it('logs SDK warnings as metadata only', async () => {
    useModel(
      mockModel([textParts('ok')], {
        warnings: [
          {
            type: 'other',
            message: 'skip_thought_signature_validator injected',
          },
        ],
      }),
    );

    const logs = await captureLogs(() =>
      chatModelFor(config, scriptedFetch([]).fetch).step(stepRequest(config)),
    );

    expect(logs).toContain('ai.provider.warning');
    expect(logs).toContain('skip_thought_signature_validator');
    expect(logs).not.toContain('frozen system prompt');
    expect(logs).not.toContain('Find the MacBook');
  });
});

describe('AiProvidersModule', () => {
  @Module({})
  class EmptySettingsModule {}

  it('provides CHAT_MODEL_PORT and the model list service, and boots before a settings reader exists', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AiProvidersModule],
    })
      .overrideModule(AiSettingsModule)
      .useModule(EmptySettingsModule)
      .compile();

    const port = moduleRef.get<ChatModelPort>(CHAT_MODEL_PORT);
    expect(port).toBeInstanceOf(AiSdkChatModel);
    expect(moduleRef.get(AiModelListService)).toBeInstanceOf(
      AiModelListService,
    );
    await expect(port.step(stepRequest(config))).rejects.toMatchObject({
      code: 'AI_DISABLED',
    });
  });

  it('reads the connection from the AI_SETTINGS_READER that AiSettingsModule exports', async () => {
    const reader = readerFor({ ...config, apiKey: null });
    const resolve = jest.spyOn(reader, 'resolveProviderConfig');

    @Module({
      providers: [{ provide: AI_SETTINGS_READER, useValue: reader }],
      exports: [AI_SETTINGS_READER],
    })
    class FakeSettingsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AiProvidersModule],
    })
      .overrideModule(AiSettingsModule)
      .useModule(FakeSettingsModule)
      .compile();

    await expect(
      moduleRef.get<ChatModelPort>(CHAT_MODEL_PORT).step(stepRequest(config)),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
