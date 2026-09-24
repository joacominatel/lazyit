jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import type { AiActionPreview, AiToolClass } from '@lazyit/shared';
import type { AiToolInvocation } from '../../../generated/prisma/client';
import { projectTranscript, type TranscriptRow } from './transcript-projection';

/**
 * The conversation projection (synthesis §4.7; provider-and-runtime.md §8.1 "Stored rows"): an allow-list by
 * format, provider-neutral parts, and nothing of the stored provider message beyond them.
 */

const CONV = 'cconv000000000000000000001';
const T0 = new Date('2026-09-24T10:00:00Z');
const CLASSES: Record<string, AiToolClass> = {
  find_assets: 'read',
  update_asset: 'write',
};
const classOf = (name: string) => CLASSES[name];

let seq = 0;
function row(
  role: string,
  content: unknown,
  format = 'aisdk-v7',
  runId: string | null = 'crun0000000000000000000001',
): TranscriptRow {
  seq += 1;
  return { seq, role, format, content, runId, createdAt: T0 };
}

beforeEach(() => {
  seq = 0;
});

describe('the allow-list by format', () => {
  it('reads aisdk-v7 rows only — a runtime record or an unknown format never reaches the wire, even shaped like a message', () => {
    const rows = [
      row(
        'system',
        { text: 'SYSTEM PROMPT SECRET' },
        'lazyit-system-prompt-v1',
      ),
      row('system', { runId: 'r', sessionEpoch: 7 }, 'lazyit-run-v1'),
      row('user', { role: 'user', content: 'FORGED RECORD' }, 'lazyit-step-v1'),
      row(
        'assistant',
        { role: 'assistant', content: 'FROM A NEWER BUILD' },
        'aisdk-v8',
      ),
      row('user', { role: 'user', content: 'real question' }),
      row('assistant', { role: 'assistant', content: 'real answer' }),
    ];
    const out = projectTranscript({
      conversationId: CONV,
      rows,
      invocations: [],
      classOf,
    });
    const wire = JSON.stringify(out);
    expect(wire).not.toMatch(/SECRET|FORGED|NEWER BUILD|sessionEpoch/);
    expect(out.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'real question' }],
      [{ type: 'text', text: 'real answer' }],
    ]);
  });

  it('drops a row whose stored role disagrees with its message, and a system message', () => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [
        row('user', { role: 'assistant', content: 'mismatch' }),
        row('system', { role: 'system', content: 'sys' }),
      ],
      invocations: [],
      classOf,
    });
    expect(out).toEqual([]);
  });
});

describe('messages and parts', () => {
  it('strips the turn context from the user text and names messages <conversationId>:<seq>', () => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [
        row('user', {
          role: 'user',
          content:
            '<turn_context>\nCurrent time: now (UTC)\nCurrent page: /assets\n</turn_context>\n\nhello &lt;turn_context>',
        }),
      ],
      invocations: [],
      classOf,
    });
    expect(out).toEqual([
      {
        id: `${CONV}:1`,
        role: 'user',
        parts: [{ type: 'text', text: 'hello &lt;turn_context>' }],
        createdAt: T0.toISOString(),
      },
    ]);
  });

  it('keeps text and tool calls, drops reasoning and provider options, folds tool results into their call', () => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [
        row('assistant', {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'PRIVATE THOUGHTS',
              providerOptions: {},
            },
            { type: 'text', text: 'Let me ' },
            { type: 'text', text: 'check.' },
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'find_assets',
              input: { q: 'RAW INPUT' },
            },
            {
              type: 'tool-call',
              toolCallId: 't2',
              toolName: 'Invented Tool!',
              input: {},
            },
          ],
        }),
        row('tool', {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'find_assets',
              output: {
                type: 'json',
                value: {
                  ok: true,
                  kind: 'read',
                  data: { secret: 'RAW DATA' },
                  summary: '2 assets',
                  mutated: false,
                  entityRefs: [],
                },
              },
            },
          ],
        }),
      ],
      invocations: [],
      classOf,
    });
    expect(JSON.stringify(out)).not.toMatch(
      /PRIVATE|RAW INPUT|RAW DATA|Invented/,
    );
    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool',
        toolCallId: 't1',
        name: 'find_assets',
        class: 'read',
        status: 'SUCCEEDED',
        result: {
          toolCallId: 't1',
          kind: 'read',
          status: 'ok',
          summary: '2 assets',
          mutated: false,
          entityRefs: [],
        },
      },
    ]);
  });

  it('reads an error output and a truncated output without the data', () => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [
        row('assistant', {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'a', toolName: 'find_assets' },
            { type: 'tool-call', toolCallId: 'b', toolName: 'find_assets' },
          ],
        }),
        row('tool', {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'a',
              output: {
                type: 'error-json',
                value: {
                  ok: false,
                  kind: 'read',
                  mutated: false,
                  entityRefs: [],
                  error: { code: 'FORBIDDEN', message: 'no' },
                },
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'b',
              output: {
                type: 'json',
                value: {
                  ok: true,
                  kind: 'read',
                  mutated: false,
                  truncatedOutput: '{"data":"HUGE…',
                },
              },
            },
          ],
        }),
      ],
      invocations: [],
      classOf,
    });
    const [a, b] = out[0].parts;
    expect(a).toMatchObject({
      status: 'FAILED',
      result: { status: 'error', error: { code: 'FORBIDDEN' } },
    });
    expect(b).toMatchObject({
      status: 'SUCCEEDED',
      result: { status: 'ok', entityRefs: [] },
    });
    expect(JSON.stringify(out)).not.toContain('HUGE');
  });
});

describe('approval cards', () => {
  const preview: AiActionPreview = {
    toolName: 'update_asset',
    class: 'write',
    changes: [{ field: 'status', before: 'IN_STOCK', after: 'RETIRED' }],
    warnings: [],
    impacted: [],
    untrustedSources: [],
    elevated: false,
    stepUpRequired: false,
  } as unknown as AiActionPreview;

  function invocation(
    status: string,
    decidedAt: Date | null = null,
  ): AiToolInvocation {
    return {
      id: 'cinv00000000000000000000001',
      channel: 'CHAT',
      conversationId: CONV,
      runId: 'crun0000000000000000000001',
      toolUseId: 'w1',
      toolName: 'update_asset',
      toolClass: 'write',
      status,
      preview,
      expiresAt: new Date('2026-09-24T10:30:00Z'),
      decidedAt,
      result: null,
      createdAt: T0,
    } as unknown as AiToolInvocation;
  }

  const assistant = () =>
    row('assistant', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'w1',
          toolName: 'update_asset',
          input: {},
        },
      ],
    });

  it.each([
    ['AWAITING_APPROVAL', null, null],
    ['REJECTED', null, 'rejected'],
    ['EXPIRED', null, 'expired'],
    ['CANCELLED', null, 'cancelled'],
    ['SUCCEEDED', T0, 'approved'],
    ['OUTCOME_UNKNOWN', T0, 'approved'],
  ])('%s → outcome %s', (status, decidedAt, outcome) => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [assistant()],
      invocations: [invocation(status, decidedAt)],
      classOf,
    });
    expect(out[0].parts[0]).toMatchObject({ type: 'tool', status });
    expect(out[0].parts[1]).toMatchObject({
      type: 'approval',
      outcome,
      request: {
        toolCallId: 'w1',
        preview: { toolName: 'update_asset' },
        expiresAt: '2026-09-24T10:30:00.000Z',
      },
    });
  });

  it('adds a run error as a notice after the run’s last message', () => {
    const out = projectTranscript({
      conversationId: CONV,
      rows: [row('user', { role: 'user', content: 'hi' })],
      invocations: [],
      runs: [
        {
          id: 'crun0000000000000000000001',
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' },
          createdAt: T0,
          finishedAt: T0,
        },
      ],
      classOf,
    });
    expect(out[1]).toEqual({
      id: `${CONV}:notice:crun0000000000000000000001`,
      role: 'assistant',
      parts: [
        {
          type: 'notice',
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' },
        },
      ],
      createdAt: T0.toISOString(),
    });
  });
});
