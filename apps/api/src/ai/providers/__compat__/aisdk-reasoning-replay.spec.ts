/**
 * Compatibility regression (epic #1315 W1-B item d): the provider's opaque reasoning state survives
 * the way lazyit persists a conversation — `responseMessages` → JSON column → `JSON.parse` — and is
 * replayed on the provider's wire in the next step. Without it the next call after a tool call is
 * rejected (Anthropic thinking signature, Gemini 3 thought signature) or loses its reasoning
 * (OpenAI Responses with `store: false`).
 *
 * Each case runs the real provider package against a fake `fetch`. The SSE fixtures are hand-written
 * from the providers' documented stream formats — no live key is used. Step 1 streams reasoning plus a
 * tool call; the loop appends a tool result; step 2's HTTP request body must carry the signature.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
} from 'ai';

type FetchFn = typeof globalThis.fetch;

const tools = {
  lazyit_search: tool({
    description: 'Search lazyit.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    }),
  }),
};

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
    )
    .join('');
}

/** A fake provider endpoint: serves one SSE body per call and records every request body. */
function scriptedFetch(bodies: string[]): {
  fetch: FetchFn;
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  const fetch: FetchFn = (_input, init) => {
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    const body = bodies[requests.length - 1];
    if (body === undefined) {
      return Promise.reject(
        new Error(`unexpected provider call #${requests.length}`),
      );
    }
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  return { fetch, requests };
}

/**
 * Two loop steps exactly as lazyit runs them: one `streamText` per step, the assistant message
 * persisted through a JSON round trip, then a tool result appended before the next step.
 */
async function runTwoSteps(
  model: LanguageModel,
  providerOptions?: Record<string, Record<string, string | boolean>>,
) {
  const history: ModelMessage[] = [
    { role: 'user', content: 'Find the MacBook' },
  ];

  const step1 = streamText({
    model,
    messages: history,
    tools,
    stopWhen: isStepCount(1),
    providerOptions,
  });
  await step1.consumeStream();
  const toolCalls = await step1.toolCalls;
  expect(toolCalls.map((c) => c.toolName)).toEqual(['lazyit_search']);

  // Persist and reload, as the Postgres jsonb column will.
  const persisted = JSON.parse(
    JSON.stringify(await step1.responseMessages),
  ) as ModelMessage[];
  history.push(...persisted, {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: toolCalls[0].toolCallId,
        toolName: 'lazyit_search',
        output: { type: 'json', value: { items: [] } },
      },
    ],
  });

  const step2 = streamText({
    model,
    messages: history,
    tools,
    stopWhen: isStepCount(1),
    providerOptions,
  });
  return { persisted, text: await step2.text };
}

describe('reasoning state survives persistence and replays (per provider)', () => {
  it('Anthropic: the thinking block and its signature are replayed before the tool_use', async () => {
    const step1 = sse([
      {
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
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
      },
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
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 20 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const step2 = sse([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 30, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'No MacBook found.' },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: 0 },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch, requests } = scriptedFetch([step1, step2]);
    const model = createAnthropic({
      apiKey: 'test-key',
      baseURL: 'https://anthropic.test/v1',
      fetch,
    })('claude-opus-5');

    const { persisted, text } = await runTwoSteps(model);

    expect(text).toBe('No MacBook found.');
    expect(JSON.stringify(persisted)).toContain('SIG-ANTHROPIC');
    const replayed = requests[1].messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(replayed[1].role).toBe('assistant');
    expect(replayed[1].content[0]).toEqual({
      type: 'thinking',
      thinking: 'Search first.',
      signature: 'SIG-ANTHROPIC',
    });
    expect(replayed[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'lazyit_search',
    });
    expect(replayed[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
    });
  });

  it('OpenAI Responses (store: false): the reasoning item is replayed with its encrypted_content', async () => {
    const step1 = sse([
      {
        data: {
          type: 'response.created',
          response: {
            id: 'resp_1',
            created_at: 1758600000,
            model: 'gpt-6-sol',
          },
        },
      },
      {
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: null },
        },
      },
      {
        data: {
          type: 'response.reasoning_summary_part.added',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
        },
      },
      {
        data: {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          delta: 'Search first.',
        },
      },
      {
        data: {
          type: 'response.reasoning_summary_part.done',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
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
      {
        data: {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 20,
              output_tokens_details: { reasoning_tokens: 12 },
            },
          },
        },
      },
    ]);
    const step2 = sse([
      {
        data: {
          type: 'response.created',
          response: {
            id: 'resp_2',
            created_at: 1758600001,
            model: 'gpt-6-sol',
          },
        },
      },
      {
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_2' },
        },
      },
      {
        data: {
          type: 'response.output_text.delta',
          item_id: 'msg_2',
          output_index: 0,
          delta: 'No MacBook found.',
        },
      },
      {
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: 'msg_2' },
        },
      },
      {
        data: {
          type: 'response.completed',
          response: { usage: { input_tokens: 30, output_tokens: 5 } },
        },
      },
    ]);
    const { fetch, requests } = scriptedFetch([step1, step2]);
    const model = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openai.test/v1',
      fetch,
    })('gpt-6-sol');

    const { persisted, text } = await runTwoSteps(model, {
      openai: { store: false },
    });

    expect(text).toBe('No MacBook found.');
    expect(JSON.stringify(persisted)).toContain('ENC-OPENAI');
    // store: false makes the SDK ask for the encrypted reasoning so it can be replayed statelessly.
    expect(requests[0]).toMatchObject({
      store: false,
      include: expect.arrayContaining([
        'reasoning.encrypted_content',
      ]) as unknown,
    });
    const input = requests[1].input as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === 'reasoning')).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENC-OPENAI',
      summary: [{ type: 'summary_text', text: 'Search first.' }],
    });
    expect(input.some((item) => item.type === 'item_reference')).toBe(false);
    expect(
      input.find((item) => item.type === 'function_call_output'),
    ).toMatchObject({ call_id: 'call_1' });
  });

  it('Gemini: the functionCall part is replayed with its own thoughtSignature (not the skip sentinel)', async () => {
    const step1 = sse([
      {
        data: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Search first.', thought: true },
                  {
                    functionCall: {
                      name: 'lazyit_search',
                      args: { query: 'MacBook' },
                    },
                    thoughtSignature: 'SIG-GEMINI',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
          },
        },
      },
    ]);
    const step2 = sse([
      {
        data: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'No MacBook found.' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 30,
            candidatesTokenCount: 5,
            totalTokenCount: 35,
          },
        },
      },
    ]);
    const { fetch, requests } = scriptedFetch([step1, step2]);
    const model = createGoogle({
      apiKey: 'test-key',
      baseURL: 'https://gemini.test/v1beta',
      fetch,
    })('gemini-3.8-flash');

    const { persisted, text } = await runTwoSteps(model);

    expect(text).toBe('No MacBook found.');
    expect(JSON.stringify(persisted)).toContain('SIG-GEMINI');
    const contents = requests[1].contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const modelTurn = contents.find((c) => c.role === 'model');
    const call = modelTurn?.parts.find((p) => 'functionCall' in p);
    expect(call).toMatchObject({
      functionCall: { name: 'lazyit_search', args: { query: 'MacBook' } },
      thoughtSignature: 'SIG-GEMINI',
    });
    expect(JSON.stringify(requests[1])).not.toContain(
      'skip_thought_signature_validator',
    );
  });
});
