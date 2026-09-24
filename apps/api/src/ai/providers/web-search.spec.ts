// The real settings module pulls the generated Prisma client, which this unit spec does not need.
jest.mock('../settings/ai-settings.module', () => {
  const { Module } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  class AiSettingsModule {}
  Module({})(AiSettingsModule);
  return { AiSettingsModule };
});

import { simulateReadableStream, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { anthropicProvider } from './anthropic/anthropic.provider';
import { googleProvider } from './google/google.provider';
import { webSearchOf, webSearchToolFor } from './model-step';
import { openaiCompatibleProvider } from './openai-compatible/openai-compatible.provider';
import { openaiProvider } from './openai/openai.provider';
import {
  SEARCH_TOOL,
  chatModelFor,
  providerConfig,
  scriptedFetch,
  stepRequest,
} from './provider.harness-spec';

/**
 * Provider-native web search (#1389; ADR-0097 decision 3 as amended 2026-09-24): the provider layer
 * declares the provider's own search tool only when the conversation carries it and the provider and
 * model support it; the provider runs it (lazyit never answers it); the step reports the searches, the
 * queries and the http(s) sources; a paused server-side turn is flagged for the loop to continue.
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

function mockModel(steps: StreamPart[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({
      stream: simulateReadableStream({ chunks }),
    })),
  });
}

/** A step in which the provider searched once, cited two pages (one unsafe) and answered. */
function searchedStep(raw = 'end_turn'): StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: 'srvtoolu_1',
      toolName: 'web_search',
      input: '{"query":"Easy Redmine workflow"}',
      providerExecuted: true,
    },
    {
      type: 'tool-result',
      toolCallId: 'srvtoolu_1',
      toolName: 'web_search',
      result: [
        {
          type: 'web_search_result',
          url: 'https://www.easyredmine.com/docs/workflow',
          title: 'Workflow — Easy Redmine',
          pageAge: null,
          encryptedContent: 'enc',
        },
      ],
    },
    {
      type: 'source',
      sourceType: 'url',
      id: 's1',
      url: 'https://www.easyredmine.com/docs/workflow',
      title: '  Workflow —\n Easy Redmine ',
    },
    {
      type: 'source',
      sourceType: 'url',
      id: 's2',
      url: 'javascript:alert(1)',
      title: 'evil',
    },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'Easy Redmine is a project tool.' },
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw },
      usage,
    },
  ] as StreamPart[];
}

describe('webSearchToolFor — the tool is declared only when carried and supported', () => {
  const request = { tools: [SEARCH_TOOL], webSearch: { maxUses: 3 } };

  it('Anthropic: the basic web_search server tool with the conversation cap', () => {
    const search = webSearchToolFor(
      anthropicProvider,
      'claude-opus-5',
      request,
    );
    expect(search?.name).toBe('web_search');
    expect(search?.tool).toMatchObject({
      type: 'provider',
      id: 'anthropic.web_search_20250305',
      args: { maxUses: 3 },
    });
  });

  it('OpenAI: the Responses web_search tool', () => {
    expect(
      webSearchToolFor(openaiProvider, 'gpt-6-sol', request)?.tool,
    ).toMatchObject({ type: 'provider', id: 'openai.web_search' });
  });

  it('Google: google_search grounding on Gemini 3, never on an older Gemini', () => {
    expect(
      webSearchToolFor(googleProvider, 'gemini-3.8-flash', request)?.name,
    ).toBe('google_search');
    expect(
      webSearchToolFor(googleProvider, 'gemini-2.5-flash', request),
    ).toBeNull();
  });

  it('never for the OpenAI-compatible provider, nor without the conversation carrying it', () => {
    expect(
      webSearchToolFor(openaiCompatibleProvider, 'llama', request),
    ).toBeNull();
    expect(
      webSearchToolFor(anthropicProvider, 'claude-opus-5', {
        tools: [SEARCH_TOOL],
      }),
    ).toBeNull();
  });

  it('a lazyit tool with the same name wins: the search is dropped, never the lazyit tool', () => {
    expect(
      webSearchToolFor(anthropicProvider, 'claude-opus-5', {
        tools: [{ ...SEARCH_TOOL, name: 'web_search' }],
        webSearch: { maxUses: 3 },
      }),
    ).toBeNull();
  });
});

describe('webSearchOf — what the search did, read defensively', () => {
  it('counts the provider-executed calls, keeps the queries and only http(s) sources', () => {
    const result = webSearchOf(
      [
        {
          type: 'tool-call',
          toolName: 'web_search',
          providerExecuted: true,
          input: { query: '  easy   redmine ' },
        },
        {
          type: 'tool-call',
          toolName: 'web_search',
          providerExecuted: true,
          input: { query: 'easy redmine' },
        },
        { type: 'tool-call', toolName: 'asset_search', input: { query: 'x' } },
        {
          type: 'tool-result',
          toolName: 'web_search',
          providerExecuted: true,
          output: { action: { query: 'redmine api' } },
        },
      ],
      [
        { sourceType: 'url', url: 'https://a.example/x', title: 'A' },
        { sourceType: 'url', url: 'https://a.example/x', title: 'dup' },
        { sourceType: 'url', url: 'data:text/html,x', title: 'no' },
        { sourceType: 'document', title: 'not a web page' },
        { sourceType: 'url', url: 'http://b.example', title: '' },
      ],
      undefined,
      'web_search',
    );
    expect(result).toEqual({
      searches: 2,
      queries: ['easy redmine', 'redmine api'],
      sources: [
        { url: 'https://a.example/x', title: 'A' },
        { url: 'http://b.example', title: null },
      ],
    });
  });

  it('reads Gemini grounding queries from the provider metadata', () => {
    const result = webSearchOf(
      [],
      [{ sourceType: 'url', url: 'https://g.example', title: 'G' }],
      { google: { groundingMetadata: { webSearchQueries: ['q1', 'q2', 7] } } },
      'google_search',
    );
    expect(result).toMatchObject({ searches: 2, queries: ['q1', 'q2'] });
  });

  it('is null when nothing was searched and nothing cited', () => {
    expect(webSearchOf([], [], undefined, 'web_search')).toBeNull();
  });
});

describe('runModelStep with web search (Anthropic, SDK mock model)', () => {
  let createModel: jest.SpyInstance;
  afterEach(() => createModel?.mockRestore());

  function useModel(model: MockLanguageModelV4): void {
    createModel = jest
      .spyOn(anthropicProvider, 'createModel')
      .mockReturnValue(model);
  }

  const config = providerConfig();

  it('without web search the provider is sent lazyit tools only', async () => {
    const model = mockModel([searchedStep()]);
    useModel(model);
    await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config),
    );
    expect(model.doStreamCalls[0].tools?.map((t) => t.name)).toEqual([
      'lazyit_search',
    ]);
  });

  it('declares the search, never returns its call to the loop, and reports it', async () => {
    const model = mockModel([searchedStep()]);
    useModel(model);
    const result = await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config, { webSearch: { maxUses: 4 } }),
    );

    const tools = model.doStreamCalls[0].tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(['lazyit_search', 'web_search']);
    expect(tools[1]).toMatchObject({
      type: 'provider',
      id: 'anthropic.web_search_20250305',
      args: { maxUses: 4 },
    });
    // The provider ran it: lazyit has nothing to answer.
    expect(result.toolCalls).toEqual([]);
    expect(result.paused).toBeUndefined();
    expect(result.webSearch).toEqual({
      searches: 1,
      queries: ['Easy Redmine workflow'],
      sources: [
        {
          url: 'https://www.easyredmine.com/docs/workflow',
          title: 'Workflow — Easy Redmine',
        },
      ],
    });
    // The provider's own call and result stay in the assistant message, to be replayed as they are.
    const [message] = result.responseMessages as ModelMessage[];
    const types = (message.content as Array<{ type: string }>).map(
      (p) => p.type,
    );
    expect(types).toEqual(['tool-call', 'tool-result', 'text']);
  });

  it('flags a paused server-side turn (pause_turn) for the loop to continue', async () => {
    useModel(mockModel([searchedStep('pause_turn')]));
    const result = await chatModelFor(config, scriptedFetch([]).fetch).step(
      stepRequest(config, { webSearch: { maxUses: 4 } }),
    );
    expect(result.paused).toBe(true);
  });
});
