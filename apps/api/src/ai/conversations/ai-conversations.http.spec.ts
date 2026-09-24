/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- assertions read loosely-typed HTTP bodies and in-memory rows; intentional for this spec file only. */
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

import { Logger } from '@nestjs/common';
import request from 'supertest';
import { AiConversationDetailSchema } from '@lazyit/shared';
import { buildHttp, type HttpHarness } from '../runs/ai-http.harness-spec';
import { TOOLS } from '../runtime/runtime.harness-spec';

/**
 * `/ai/conversations` over HTTP (W3-1; synthesis §4.7; frontend.md K3–K4): the real controller, guard chain
 * and validation pipe over the real runtime. Owner-only isolation, the provider-neutral projection (the
 * runtime's records never reach the wire), delete semantics, and the AI-off behaviour.
 */

let h: HttpHarness;
const http = () => request(h.app.getHttpServer());

beforeAll(() => Logger.overrideLogger(false));
beforeEach(async () => {
  h = await buildHttp();
});
afterEach(() => h.close());

async function newConversation(as = 'A'): Promise<string> {
  const res = await http()
    .post('/ai/conversations')
    .set('X-Test-Principal', as)
    .set('Accept-Language', 'es-AR,es;q=0.9');
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function say(conversationId: string, text: string, as = 'A') {
  return http()
    .post(`/ai/conversations/${conversationId}/messages`)
    .set('X-Test-Principal', as)
    .send({ text, context: { route: '/assets/a1' } });
}

describe('create, send and read', () => {
  it('creates a frozen conversation and answers a message with 202 { runId, status }', async () => {
    const id = await newConversation();
    h.rt.model.push({ text: 'Hello Ada.' });
    const res = await say(id, 'Hi');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: expect.any(String), status: 'QUEUED' });
    expect(h.rt.run(res.body.runId)).toMatchObject({
      channel: 'CHAT',
      approvalPolicy: 'REQUIRE_APPROVAL_FOR_WRITES',
      userId: expect.any(String),
    });
  });

  it('projects the transcript: the user text without the turn context, the answer, tool activity', async () => {
    const id = await newConversation();
    h.rt.model.push(
      {
        toolCalls: [
          {
            toolCallId: 'r1',
            toolName: TOOLS.read.descriptor.name,
            input: { id: 'a1' },
          },
        ],
      },
      { text: 'You have one asset.' },
    );
    await say(id, 'How many assets?');
    await h.rt.drain();

    const res = await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    expect(res.status).toBe(200);
    expect(AiConversationDetailSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      id,
      title: 'How many assets?',
      status: 'idle',
      readOnly: false,
      activeRunId: null,
    });
    const [user, call, answer] = res.body.messages;
    expect(user).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'How many assets?' }],
    });
    expect(call.parts).toEqual([
      {
        type: 'tool',
        toolCallId: 'r1',
        name: 'find_assets',
        class: 'read',
        status: 'SUCCEEDED',
        result: {
          toolCallId: 'r1',
          kind: 'read',
          status: 'ok',
          summary: '1 asset',
          mutated: false,
          entityRefs: [],
        },
      },
    ]);
    expect(answer.parts).toEqual([
      { type: 'text', text: 'You have one asset.' },
    ]);
    expect(res.body.messages).toHaveLength(3);
  });

  it('never puts a runtime record on the wire: no system prompt, run record, step ledger or raw result data', async () => {
    const id = await newConversation();
    h.rt.model.push(
      {
        toolCalls: [
          {
            toolCallId: 'r1',
            toolName: TOOLS.read.descriptor.name,
            input: { id: 'a1' },
          },
        ],
      },
      { text: 'Done.' },
    );
    await say(id, 'Look it up');
    await h.rt.drain();
    const stored = h.rt.messages(id);
    const systemPrompt = stored.find(
      (r) => r.format === 'lazyit-system-prompt-v1',
    )!.content.text as string;
    expect(stored.map((r) => r.format)).toEqual(
      expect.arrayContaining(['lazyit-run-v1', 'lazyit-step-v1']),
    );

    const res = await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(systemPrompt.slice(0, 60));
    expect(wire).not.toContain('turn_context');
    expect(wire).not.toContain('sessionEpoch');
    expect(wire).not.toContain('stepIndex');
    expect(wire).not.toContain('LZ-0001'); // the read result's data, never projected
    for (const message of res.body.messages) {
      expect(['user', 'assistant']).toContain(message.role);
    }
  });

  it('shows the approval card with the stored preview and its outcome', async () => {
    const id = await newConversation();
    h.rt.model.push(
      {
        toolCalls: [
          {
            toolCallId: 'w1',
            toolName: TOOLS.write.descriptor.name,
            input: { id: 'a1' },
          },
        ],
      },
      { text: 'Retired.' },
    );
    const { body } = await say(id, 'Retire a1');
    await h.rt.drain();

    let res = await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    expect(res.body).toMatchObject({
      status: 'awaiting-approval',
      activeRunId: body.runId,
    });
    const card = res.body.messages[1].parts;
    expect(card[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'w1',
      status: 'AWAITING_APPROVAL',
    });
    expect(card[1]).toMatchObject({
      type: 'approval',
      outcome: null,
      request: {
        toolCallId: 'w1',
        elevated: false,
        preview: { toolName: 'update_asset', class: 'write' },
      },
    });

    await http()
      .post(`/ai/runs/${body.runId}/tool-calls/w1/decision`)
      .set('X-Test-Principal', 'A')
      .send({ decision: 'approve' })
      .expect(200);
    await h.rt.drain();
    res = await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    expect(res.body.status).toBe('idle');
    expect(res.body.messages[1].parts[1]).toMatchObject({
      type: 'approval',
      outcome: 'approved',
    });
    expect(res.body.messages[1].parts[0]).toMatchObject({
      status: 'SUCCEEDED',
      result: { status: 'ok', mutated: true, summary: 'Asset retired' },
    });
  });

  it('shows a failed run as a notice', async () => {
    const id = await newConversation();
    h.rt.model.push({
      error: Object.assign(new Error('provider down'), {
        code: 'PROVIDER_UNAVAILABLE',
      }),
    });
    await say(id, 'Hi');
    await h.rt.drain();
    const res = await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    const last = res.body.messages[res.body.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.parts).toContainEqual({
      type: 'notice',
      error: expect.objectContaining({ code: expect.any(String) }),
    });
  });
});

describe('list', () => {
  it("lists only the caller's conversations, most recent first, as a Page", async () => {
    const first = await newConversation('A');
    const second = await newConversation('A');
    await newConversation('B');
    h.rt.prisma.tables.aiConversation.rows.find(
      (r) => r.id === first,
    )!.lastActivityAt = new Date(Date.now() + 60_000);

    const res = await http()
      .get('/ai/conversations?limit=10')
      .set('X-Test-Principal', 'A');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, limit: 10, offset: 0 });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      first,
      second,
    ]);
    expect(res.body.items[0]).toEqual({
      id: first,
      title: null,
      updatedAt: expect.any(String),
      status: 'idle',
      readOnly: false,
    });
  });

  it('marks a conversation pinned to another model read-only, and a bad page query 400', async () => {
    await newConversation('A');
    h.rt.settings.config = { ...h.rt.settings.config!, model: 'other-model' };
    const res = await http()
      .get('/ai/conversations')
      .set('X-Test-Principal', 'A');
    expect(res.body.items[0].readOnly).toBe(true);
    await http()
      .get('/ai/conversations?limit=0')
      .set('X-Test-Principal', 'A')
      .expect(400);
  });
});

describe('owner-only isolation (ADR-0097 default 3)', () => {
  it("answers 404 to another user — even an admin — on A's conversation, read, send and delete", async () => {
    const id = await newConversation('A');
    for (const who of ['B', 'ADMIN']) {
      await http()
        .get(`/ai/conversations/${id}`)
        .set('X-Test-Principal', who)
        .expect(404);
      await http()
        .delete(`/ai/conversations/${id}`)
        .set('X-Test-Principal', who)
        .expect(404);
    }
    const res = await say(id, 'hijack', 'B');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(h.rt.prisma.tables.aiConversation.rows).toHaveLength(1);
    expect(h.rt.prisma.tables.aiRun.rows).toHaveLength(0);
    const list = await http()
      .get('/ai/conversations')
      .set('X-Test-Principal', 'B');
    expect(list.body.total).toBe(0);
  });

  it('answers the same 404 for a malformed id', async () => {
    await http()
      .get('/ai/conversations/..%2Fetc')
      .set('X-Test-Principal', 'A')
      .expect(404);
  });

  it('refuses a Service Account (the chat is the human channel) and a user without ai:use', async () => {
    h.rt.loader.saPermissions.add('ai:use');
    const sa = await http()
      .get('/ai/conversations')
      .set('X-Test-Principal', 'SA');
    expect(sa.status).toBe(403);
    expect(sa.body).toMatchObject({ code: 'FORBIDDEN' });
    await http()
      .post('/ai/conversations')
      .set('X-Test-Principal', 'SA')
      .expect(403);

    h.rt.permissions.memberPermissions.delete('ai:use');
    await http()
      .get('/ai/conversations')
      .set('X-Test-Principal', 'A')
      .expect(403);
    await http().get('/ai/conversations').expect(403); // anonymous
  });
});

describe('delete', () => {
  it('refuses while a run is active (409 RUN_IN_PROGRESS), then hard-deletes the transcript and keeps the run row', async () => {
    const id = await newConversation();
    h.rt.model.push({ text: 'ok' });
    const { body } = await say(id, 'Hi');

    const busy = await http()
      .delete(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A');
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'RUN_IN_PROGRESS' });

    await h.rt.drain();
    await http()
      .delete(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A')
      .expect(204);
    expect(h.rt.messages(id)).toHaveLength(0);
    expect(h.rt.run(body.runId)).toMatchObject({
      conversationId: null,
      status: 'SUCCEEDED',
    });
    await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A')
      .expect(404);
  });
});

describe('AI switched off', () => {
  it('refuses to create or send (409 AI_DISABLED) but keeps conversations readable and deletable', async () => {
    const id = await newConversation();
    h.rt.settings.config = null;

    const created = await http()
      .post('/ai/conversations')
      .set('X-Test-Principal', 'A');
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ code: 'AI_DISABLED' });
    const sent = await say(id, 'Hi');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ code: 'AI_DISABLED' });

    await http()
      .get(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A')
      .expect(200);
    await http()
      .get('/ai/conversations')
      .set('X-Test-Principal', 'A')
      .expect(200);
    await http()
      .delete(`/ai/conversations/${id}`)
      .set('X-Test-Principal', 'A')
      .expect(204);
  });

  it('validates the message body (400) before anything runs', async () => {
    const id = await newConversation();
    await http()
      .post(`/ai/conversations/${id}/messages`)
      .set('X-Test-Principal', 'A')
      .send({ text: '' })
      .expect(400);
    await http()
      .post(`/ai/conversations/${id}/messages`)
      .set('X-Test-Principal', 'A')
      .send({ text: 'hi', extra: true })
      .expect(400);
    expect(h.rt.prisma.tables.aiRun.rows).toHaveLength(0);
  });
});
