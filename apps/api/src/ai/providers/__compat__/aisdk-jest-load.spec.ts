/**
 * Compatibility regression (ADR-0096, epic #1315 W1-B item a): the ESM-only AI SDK 7 packages load
 * inside the CommonJS Jest runtime, and its test mocks drive a real `generateText` / `streamText`
 * call. If this suite dies with `SyntaxError: Unexpected token 'export'`, the Jest
 * `transformIgnorePatterns` lookahead no longer covers an ESM-only package in the AI SDK graph.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

describe('AI SDK 7 under CommonJS Jest', () => {
  it('loads every provider factory the provider layer will use', () => {
    const fetch = jest.fn();
    const models = [
      createAnthropic({ apiKey: 'k', fetch })('claude-opus-5'),
      createOpenAI({ apiKey: 'k', fetch })('gpt-6-sol'),
      createGoogle({ apiKey: 'k', fetch })('gemini-3.8-flash'),
      createOpenAICompatible({
        name: 'local',
        baseURL: 'https://llm.test/v1',
        fetch,
      })('m'),
    ];
    expect(models.map((m) => m.provider)).toEqual([
      'anthropic.messages',
      'openai.responses',
      'google.generative-ai',
      'local.chat',
    ]);
    // Constructing a model never performs I/O.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drives generateText with MockLanguageModelV4 from ai/test', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'pong' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
        warnings: [],
      },
    });

    const result = await generateText({ model, prompt: 'ping' });

    expect(result.text).toBe('pong');
    expect(result.finishReason).toBe('stop');
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('drives streamText with MockLanguageModelV4 and simulateReadableStream', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'po' },
            { type: 'text-delta', id: 't1', delta: 'ng' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage,
            },
          ],
        }),
      },
    });

    const result = streamText({ model, prompt: 'ping' });
    const deltas: string[] = [];
    for await (const delta of result.textStream) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['po', 'ng']);
    expect(await result.text).toBe('pong');
  });
});
