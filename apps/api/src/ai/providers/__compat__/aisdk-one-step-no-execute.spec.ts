/**
 * Compatibility regression (epic #1315 W1-B item c): lazyit owns the agent loop, so each model step is
 * one `streamText` call with `stopWhen: isStepCount(1)` and tools declared WITHOUT `execute`. The SDK
 * must hand the tool calls back and never run a tool, never call the model a second time, and never
 * synthesize a tool message. The provider layer (docs/ai-assistant/provider-and-runtime.md §6.1)
 * relies on exactly this contract.
 */
import {
  isStepCount,
  jsonSchema,
  simulateReadableStream,
  streamText,
  tool,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

// The provider-level stream part (LanguageModelV4StreamPart), derived so no transitive package is imported.
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

// The tool set as the loop declares it: lazyit-owned JSON Schema, no `execute`.
const tools = {
  lazyit_search: tool({
    description: 'Search lazyit.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    }),
  }),
  asset_update: tool({
    description: 'Update an asset.',
    inputSchema: jsonSchema<{ id: string; name: string }>({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
      additionalProperties: false,
    }),
  }),
};

function stepModel(parts: StreamPart[]): MockLanguageModelV4 {
  const finalAnswer: StreamPart[] = [
    { type: 'text-start', id: 'x' },
    {
      type: 'text-delta',
      id: 'x',
      delta: 'SECOND STEP — must never be requested',
    },
    { type: 'text-end', id: 'x' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage,
    },
  ];
  // A second step, if the SDK ever requested one, would get the final answer.
  return new MockLanguageModelV4({
    doStream: [
      { stream: simulateReadableStream({ chunks: parts }) },
      { stream: simulateReadableStream({ chunks: finalAnswer }) },
    ],
  });
}

describe('streamText as one loop step (tools without execute)', () => {
  it('returns the tool calls, executes nothing and requests exactly one model step', async () => {
    const model = stepModel([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Let me look.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'lazyit_search',
        input: '{"query":"MacBook"}',
      },
      {
        type: 'tool-call',
        toolCallId: 'call_2',
        toolName: 'asset_update',
        input: '{"id":"a1","name":"MacBook Pro 16"}',
      },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage,
      },
    ]);

    const result = streamText({
      model,
      instructions: 'frozen system prompt',
      messages: [{ role: 'user', content: 'Rename the MacBook' }],
      tools,
      toolChoice: 'auto',
      stopWhen: isStepCount(1),
    });

    const partTypes: string[] = [];
    for await (const part of result.stream) {
      partTypes.push(part.type);
    }

    expect(model.doStreamCalls).toHaveLength(1);
    expect(await result.finishReason).toBe('tool-calls');
    expect(
      (await result.toolCalls).map((c) => [c.toolCallId, c.toolName, c.input]),
    ).toEqual([
      ['call_1', 'lazyit_search', { query: 'MacBook' }],
      ['call_2', 'asset_update', { id: 'a1', name: 'MacBook Pro 16' }],
    ]);
    expect(await result.toolResults).toEqual([]);
    expect(partTypes).toEqual(expect.arrayContaining(['tool-call']));
    expect(partTypes).not.toContain('tool-result');
    expect(partTypes).not.toContain('tool-error');
    expect(partTypes).not.toContain('tool-approval-request');

    // Exactly one assistant message to persist; no synthesized tool message.
    const messages = await result.responseMessages;
    expect(messages.map((m) => m.role)).toEqual(['assistant']);
    const content = messages[0].content as Array<{ type: string }>;
    expect(content.map((p) => p.type)).toEqual([
      'text',
      'tool-call',
      'tool-call',
    ]);

    // The model saw our frozen instructions, both tool definitions and toolChoice auto.
    const call = model.doStreamCalls[0];
    expect(call.prompt[0]).toEqual({
      role: 'system',
      content: 'frozen system prompt',
    });
    expect(call.tools?.map((t) => t.name)).toEqual([
      'lazyit_search',
      'asset_update',
    ]);
    expect(call.toolChoice).toEqual({ type: 'auto' });
  });

  it("forwards toolChoice 'none' for the forced final step", async () => {
    const model = stepModel([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Summary.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage,
      },
    ]);

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools,
      toolChoice: 'none',
      stopWhen: isStepCount(1),
    });

    expect(await result.text).toBe('Summary.');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: 'none' });
  });

  it('flags an unknown tool as invalid but does NOT validate input against a bare jsonSchema()', async () => {
    const model = stepModel([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'not_in_toolset',
        input: '{}',
      },
      {
        type: 'tool-call',
        toolCallId: 'call_2',
        toolName: 'asset_update',
        input: '{"id":42}',
      },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage,
      },
    ]);

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'x' }],
      tools,
      stopWhen: isStepCount(1),
    });
    await result.consumeStream();

    expect(model.doStreamCalls).toHaveLength(1);
    const calls = await result.toolCalls;
    // `jsonSchema()` without a `validate` function is a pass-through: the schema-violating call comes
    // back as valid. The lazyit loop must validate every call against the tool's JSON Schema itself
    // (provider-and-runtime.md §6.4) and must not rely on the SDK for it.
    expect(calls.map((c) => [c.toolName, c.invalid === true, c.input])).toEqual(
      [
        ['not_in_toolset', true, {}],
        ['asset_update', false, { id: 42 }],
      ],
    );
    expect(await result.toolResults).toEqual([]);
  });
});
