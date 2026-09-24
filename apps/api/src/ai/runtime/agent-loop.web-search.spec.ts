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

import { HttpException, Logger } from '@nestjs/common';
import { AI_WEB_SEARCH_SOURCE_REF } from '@lazyit/shared';
import { projectTranscript } from '../conversations/transcript-projection';
import {
  buildRuntime,
  HUMAN,
  SERVICE,
  TOOLS,
  type Runtime,
} from './runtime.harness-spec';

/**
 * Provider-native web search in the agent loop (#1389; ADR-0097 decision 3 as amended 2026-09-24):
 * frozen per conversation (chat only, when on and supported), passed to every model step, recorded with
 * its sources, marks the turn as having read untrusted sources (so no auto-approve), continues a paused
 * server-side turn, and turning it off makes a conversation that has it read-only.
 */

const WRITE = TOOLS.write.descriptor.name;

const SEARCHED = {
  searches: 2,
  queries: ['Easy Redmine workflow'],
  sources: [
    {
      url: 'https://www.easyredmine.com/docs/workflow',
      title: 'Workflow — Easy Redmine',
    },
  ],
};

let rt: Runtime;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  rt = buildRuntime();
});

function enableWebSearch(maxUses = 3): void {
  rt.settings.overrides = { webSearchEnabled: true, webSearchMaxUses: maxUses };
}

function conversation(id: string) {
  return rt.prisma.tables.aiConversation.rows.find((r) => r.id === id)!;
}

function systemPrompt(id: string): string {
  const row = rt.prisma.tables.aiMessage.rows.find(
    (r) => r.conversationId === id && r.format === 'lazyit-system-prompt-v1',
  )!;
  return (row.content as { text: string }).text;
}

async function newChat(settings = {}) {
  return rt.orchestrator.createConversation({
    identity: HUMAN,
    channel: 'CHAT',
    settings,
  });
}

function send(
  conversationId: string,
  text = 'Set up an Easy Redmine workflow',
) {
  return rt.orchestrator.submit({
    identity: HUMAN,
    channel: 'CHAT',
    text,
    conversationId,
  });
}

describe('freezing web search on a conversation', () => {
  it('is off by default: no cap frozen, no search sent, no web rules in the prompt', async () => {
    const { id } = await newChat();
    expect(conversation(id).webSearchMaxUses).toBeNull();
    expect(systemPrompt(id)).not.toContain('## Web search');
    rt.model.push({ text: 'ok' });
    await send(id);
    await rt.drain();
    expect(rt.model.requests[0].webSearch).toBeUndefined();
  });

  it('when on and supported, a chat conversation freezes the cap and every step carries it', async () => {
    enableWebSearch(4);
    const { id } = await newChat();
    expect(conversation(id).webSearchMaxUses).toBe(4);
    expect(systemPrompt(id)).toContain('## Web search');
    // A later change of the cap does not touch the frozen conversation (its tools stay byte-identical).
    enableWebSearch(9);
    rt.model.push({ text: 'ok' });
    await send(id);
    await rt.drain();
    expect(rt.model.requests[0].webSearch).toEqual({ maxUses: 4 });
  });

  it('never for a model that does not support it', async () => {
    enableWebSearch();
    rt.settings.config = {
      ...rt.settings.config!,
      provider: 'google',
      model: 'gemini-2.5-flash',
    };
    const { id } = await newChat();
    expect(conversation(id).webSearchMaxUses).toBeNull();
  });

  it('never for headless: its writes run with no one approving them', async () => {
    enableWebSearch();
    rt.model.push({ text: 'done' });
    const { conversationId } = await rt.orchestrator.submit({
      identity: SERVICE,
      channel: 'HEADLESS',
      text: 'Report',
    });
    await rt.drain();
    expect(conversation(conversationId).webSearchMaxUses).toBeNull();
    expect(rt.model.requests[0].webSearch).toBeUndefined();
  });
});

describe('a step that searched the web', () => {
  it('records the search after the assistant message, emits the sources, and projects them', async () => {
    enableWebSearch();
    const { id } = await newChat();
    rt.model.push({ text: 'Easy Redmine is…', webSearch: SEARCHED });
    const { runId } = await send(id);
    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');

    const rows = rt.prisma.tables.aiMessage.rows
      .filter((r) => r.conversationId === id)
      .sort((a, b) => a.seq - b.seq);
    const assistant = rows.findIndex(
      (r) => r.format === 'aisdk-v7' && r.role === 'assistant',
    );
    expect(rows[assistant + 1]).toMatchObject({
      format: 'lazyit-web-search-v1',
      role: 'system',
      runId,
      content: { stepIndex: 0, ...SEARCHED },
    });
    // Never replayed to the model.
    expect(rt.model.requests.at(-1)!.messages).not.toContainEqual(
      expect.objectContaining({ searches: 2 }),
    );

    const event = rt.events(runId).find((e) => e.type === 'message.sources');
    expect(event).toMatchObject({
      messageId: `${id}:${rows[assistant].seq}`,
      sources: SEARCHED.sources,
      queries: SEARCHED.queries,
    });

    const projected = projectTranscript({
      conversationId: id,
      rows: rows as never,
      invocations: [],
      classOf: () => undefined,
    });
    const answer = projected.find((m) => m.role === 'assistant')!;
    expect(answer.id).toBe(`${id}:${rows[assistant].seq}`);
    expect(answer.parts).toEqual([
      { type: 'text', text: 'Easy Redmine is…' },
      { type: 'sources', sources: SEARCHED.sources, queries: SEARCHED.queries },
    ]);
  });

  it('marks the turn as having read untrusted sources: the proposal shows it and is never auto-approved', async () => {
    enableWebSearch();
    const { id } = await newChat({ autoApprove: true });
    rt.model.push({ text: 'Found the docs.', webSearch: SEARCHED });
    const { runId } = await send(id);
    await rt.drain();
    // The first step had no tool call and was not paused: the run ends there. Continue the turn with a
    // step that both searches and proposes, the case that matters.
    expect(rt.run(runId).status).toBe('SUCCEEDED');

    rt.model.push({
      webSearch: SEARCHED,
      toolCalls: [{ toolCallId: 'w2', toolName: WRITE, input: { id: 'a1' } }],
    });
    const second = await send(id, 'Now retire LZ-0001');
    await rt.drain();
    expect(rt.run(second.runId).status).toBe('AWAITING_APPROVAL');
    expect(rt.tools.approved).toHaveLength(0);
    const required = rt
      .events(second.runId)
      .find((e) => e.type === 'tool.approval_required');
    expect(required).toMatchObject({
      untrustedSources: [expect.objectContaining(AI_WEB_SEARCH_SOURCE_REF)],
    });
  });

  it('a turn that searched in an earlier step keeps the mark on later proposals', async () => {
    enableWebSearch();
    const { id } = await newChat({ autoApprove: true });
    rt.model.push(
      { text: 'Searching…', webSearch: SEARCHED, paused: true },
      {
        toolCalls: [{ toolCallId: 'w1', toolName: WRITE, input: { id: 'a1' } }],
      },
    );
    const { runId } = await send(id);
    await rt.drain();
    expect(rt.run(runId).status).toBe('AWAITING_APPROVAL');
    expect(rt.tools.approved).toHaveLength(0);
  });
});

describe('once a conversation has searched, nothing in it is auto-approved (G2 review)', () => {
  it('the next turn after a search is not auto-approved: the results are still in the history', async () => {
    enableWebSearch();
    const { id } = await newChat({ autoApprove: true });
    rt.model.push({ text: 'Found the docs.', webSearch: SEARCHED });
    await send(id);
    await rt.drain();

    // Turn N+1: no search in this run, but the replayed results could carry a planted instruction.
    rt.model.push({
      toolCalls: [{ toolCallId: 'w1', toolName: WRITE, input: { id: 'a1' } }],
    });
    const next = await send(id, 'Now retire LZ-0001');
    await rt.drain();
    expect(rt.run(next.runId).status).toBe('AWAITING_APPROVAL');
    expect(rt.tools.approved).toHaveLength(0);
    const required = rt
      .events(next.runId)
      .find((e) => e.type === 'tool.approval_required');
    expect(required).toMatchObject({
      untrustedSources: [expect.objectContaining(AI_WEB_SEARCH_SOURCE_REF)],
    });
  });

  it('a later turn resumed after an approval still carries the mark', async () => {
    enableWebSearch();
    const { id } = await newChat({ autoApprove: true });
    rt.model.push({ text: 'Found the docs.', webSearch: SEARCHED });
    await send(id);
    await rt.drain();

    rt.model.push(
      {
        toolCalls: [{ toolCallId: 'w1', toolName: WRITE, input: { id: 'a1' } }],
      },
      {
        toolCalls: [{ toolCallId: 'w2', toolName: WRITE, input: { id: 'a2' } }],
      },
    );
    const { runId } = await send(id, 'Do both changes');
    await rt.drain();
    await rt.approvals.decide({
      runId,
      toolCallId: 'w1',
      decision: 'approve',
      identity: HUMAN,
    });
    await rt.drain(); // resumed in a fresh loop pass: memory is gone, the records remain
    const cards = rt
      .events(runId)
      .filter((e) => e.type === 'tool.approval_required');
    expect(cards.map((c) => (c as { toolCallId: string }).toolCallId)).toEqual([
      'w1',
      'w2',
    ]);
    expect(cards[1]).toMatchObject({
      untrustedSources: [expect.objectContaining(AI_WEB_SEARCH_SOURCE_REF)],
    });
    expect(rt.run(runId).status).toBe('AWAITING_APPROVAL');
  });

  it('a conversation that never searched keeps auto-approve', async () => {
    enableWebSearch();
    const { id } = await newChat({ autoApprove: true });
    rt.model.push(
      {
        toolCalls: [{ toolCallId: 'w1', toolName: WRITE, input: { id: 'a1' } }],
      },
      { text: 'Done.' },
    );
    await send(id);
    await rt.drain();
    expect(rt.tools.approved).toHaveLength(1);
  });
});

describe('a paused server-side turn', () => {
  it('continues with another step instead of ending the run', async () => {
    enableWebSearch();
    const { id } = await newChat();
    rt.model.push(
      { text: 'Searching…', webSearch: SEARCHED, paused: true },
      { text: 'Here is what I found.' },
    );
    const { runId } = await send(id);
    await rt.drain();
    expect(rt.model.requests).toHaveLength(2);
    expect(rt.run(runId).status).toBe('SUCCEEDED');
  });
});

describe('turning web search off', () => {
  it('makes a conversation that has it read-only; one without it carries on', async () => {
    enableWebSearch();
    const withSearch = await newChat();
    rt.settings.overrides = { webSearchEnabled: false };
    const without = await newChat();

    let refused: HttpException | null = null;
    try {
      await send(withSearch.id);
    } catch (err) {
      refused = err as HttpException;
    }
    expect(refused?.getResponse()).toMatchObject({
      code: 'CONVERSATION_READ_ONLY',
    });
    expect(conversation(withSearch.id).closedReason).toBe('CONFIG_CHANGED');

    rt.model.push({ text: 'ok' });
    const { runId } = await send(without.id);
    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');
  });

  it('a run already queued stops at its next step', async () => {
    enableWebSearch();
    const { id } = await newChat();
    const { runId } = await send(id);
    rt.settings.overrides = { webSearchEnabled: false };
    await rt.drain();
    expect(rt.run(runId).status).toBe('FAILED');
    expect(rt.run(runId).error).toMatchObject({
      code: 'CONVERSATION_READ_ONLY',
    });
    expect(conversation(id).closedReason).toBe('CONFIG_CHANGED');
  });
});
