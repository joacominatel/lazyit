import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import type { StructuredExtractionRequest } from '../core/ports/structured-extraction.port';
import { AiProviderError, AiStructuredOutputError } from './ai-provider.error';
import { anthropicProvider } from './anthropic/anthropic.provider';
import {
  chatModelFor,
  providerConfig,
  scriptedFetch,
} from './provider.harness-spec';

/**
 * The structured-extraction port over the provider layer (#1477), driven by the SDK's mock model: one
 * generate call, the file inline, NO tools declared, the answer validated against the schema.
 */

const usage = {
  inputTokens: {
    total: 1500,
    noCache: 1500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
};

const schema = z.object({ supplierName: z.string().nullable() });
const config = providerConfig();
const FILE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function request(
  over: Partial<StructuredExtractionRequest<z.infer<typeof schema>>> = {},
): StructuredExtractionRequest<z.infer<typeof schema>> {
  return {
    model: { provider: config.provider, modelId: config.model },
    instructions: 'transcribe only',
    prompt: 'Transcribe the attached document.',
    file: { data: FILE, mediaType: 'application/pdf' },
    schema,
    schemaName: 'purchase_document',
    maxOutputTokens: 2000,
    ...over,
  };
}

function modelAnswering(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage,
      warnings: [],
    },
  });
}

describe('AiSdkChatModel.extractStructured (#1477)', () => {
  let createModel: jest.SpyInstance;

  afterEach(() => createModel?.mockRestore());

  function useModel(model: MockLanguageModelV4) {
    createModel = jest
      .spyOn(anthropicProvider, 'createModel')
      .mockReturnValue(model);
  }

  it('one call, the file inline, no tools; the answer parsed against the schema', async () => {
    const model = modelAnswering('{"supplierName":"Compumundo S.A."}');
    useModel(model);

    const result = await chatModelFor(
      config,
      scriptedFetch([]).fetch,
    ).extractStructured(request());

    expect(result.output).toEqual({ supplierName: 'Compumundo S.A.' });
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 40 });
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    // Untrusted content cannot reach a tool: none is declared on the call.
    expect(call.tools ?? []).toEqual([]);
    expect(call.responseFormat).toMatchObject({
      type: 'json',
      name: 'purchase_document',
    });
    expect(call.maxOutputTokens).toBe(2000);
    expect(call.prompt[0]).toMatchObject({
      role: 'system',
      content: 'transcribe only',
    });
    const user = call.prompt[1] as {
      role: string;
      content: { type: string }[];
    };
    expect(user.role).toBe('user');
    expect(user.content.map((part) => part.type)).toEqual(['text', 'file']);
    expect(user.content[1]).toMatchObject({ mediaType: 'application/pdf' });
  });

  it('an answer that does not fit the schema throws AiStructuredOutputError with its usage', async () => {
    useModel(modelAnswering('{"supplierName": 42}'));
    const failure = await chatModelFor(config, scriptedFetch([]).fetch)
      .extractStructured(request())
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AiStructuredOutputError);
    expect((failure as AiStructuredOutputError).usage).toEqual({
      inputTokens: 1500,
      outputTokens: 40,
    });
    // No generated text travels on the error.
    expect(JSON.stringify(failure)).not.toContain('42');
  });

  it('never sends the document to a provider or model other than the configured one', async () => {
    const model = modelAnswering('{"supplierName":null}');
    useModel(model);
    await expect(
      chatModelFor(config, scriptedFetch([]).fetch).extractStructured(
        request({
          model: { provider: config.provider, modelId: 'another-model' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONVERSATION_READ_ONLY' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('fails AI_DISABLED without a usable configuration', async () => {
    await expect(
      chatModelFor(null as never, scriptedFetch([]).fetch).extractStructured(
        request(),
      ),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});
