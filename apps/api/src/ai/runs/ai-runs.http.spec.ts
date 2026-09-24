/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read loosely-typed HTTP bodies and in-memory rows; intentional for this spec file only. */
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

import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import request from 'supertest';
import { AiRunSchema } from '@lazyit/shared';
import { CONFIG, SA_ID, TOOLS } from '../runtime/runtime.harness-spec';
import { buildHttp, type HttpHarness } from './ai-http.harness-spec';

/**
 * `/ai/runs` over HTTP (W3-1; synthesis §4.4, §4.7): creation on the channel of the principal (chat for a
 * human, headless for a Service Account within its AI access setting), the run read, cancel, and the
 * approval decision with the password step-up — over the real runtime. Every route is owner-only.
 */

let h: HttpHarness;
const http = () => request(h.app.getHttpServer());
const savedMode = process.env.AUTH_MODE;

beforeAll(() => Logger.overrideLogger(false));
beforeEach(async () => {
  process.env.AUTH_MODE = 'local';
  h = await buildHttp();
});
afterEach(() => h.close());
afterAll(() => {
  process.env.AUTH_MODE = savedMode;
});

function create(as: string, body: object = { prompt: 'Count the assets' }) {
  return http().post('/ai/runs').set('X-Test-Principal', as).send(body);
}

describe('POST /ai/runs — the channel follows the principal', () => {
  it("runs a human's prompt on the chat channel (writes wait for approval)", async () => {
    const res = await create('A');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: expect.any(String), status: 'QUEUED' });
    expect(h.rt.run(res.body.runId)).toMatchObject({
      channel: 'CHAT',
      approvalPolicy: 'REQUIRE_APPROVAL_FOR_WRITES',
    });
  });

  it("runs a Service Account's prompt headless and autonomous, writes included", async () => {
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
      { text: 'Done.' },
    );
    const res = await create('SA');
    expect(res.status).toBe(202);
    expect(h.rt.run(res.body.runId)).toMatchObject({
      channel: 'HEADLESS',
      approvalPolicy: 'AUTONOMOUS',
      serviceAccountId: SA_ID,
      userId: null,
    });
    await h.rt.drain();
    const run = await http()
      .get(`/ai/runs/${res.body.runId}`)
      .set('X-Test-Principal', 'SA');
    expect(run.body).toMatchObject({
      status: 'SUCCEEDED',
      finalText: 'Done.',
      channel: 'HEADLESS',
      approvalPolicy: 'AUTONOMOUS',
      toolCalls: [
        {
          toolCallId: 'w1',
          name: 'update_asset',
          class: 'write',
          status: 'SUCCEEDED',
        },
      ],
    });
  });

  it('refuses a Service Account whose AI access is off (403 FORBIDDEN)', async () => {
    h.rt.prisma.tables.aiServiceAccountSettings.rows.push({
      serviceAccountId: SA_ID,
      access: 'off',
      maxMutationsPerRun: null,
    });
    const res = await create('SA');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('turned off'),
    });
    expect(h.rt.prisma.tables.aiRun.rows).toHaveLength(0);
  });

  it('refuses a Service Account holding infra:report (403 FORBIDDEN), whatever its setting', async () => {
    h.rt.loader.saPermissions.add('infra:report');
    const res = await create('SA');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('infra:report'),
    });
  });

  it('gives a read-only Service Account a conversation without write tools', async () => {
    h.rt.prisma.tables.aiServiceAccountSettings.rows.push({
      serviceAccountId: SA_ID,
      access: 'read-only',
      maxMutationsPerRun: null,
    });
    const res = await create('SA');
    expect(res.status).toBe(202);
    const conv = h.rt.prisma.tables.aiConversation.rows[0];
    expect(conv.toolNames).toEqual(['find_assets', 'read_article']);
  });

  it('refuses a Service Account without ai:use at the route (RolesGuard, fail-closed)', async () => {
    h.rt.loader.saPermissions.delete('ai:use');
    await create('SA').expect(403);
  });

  it('replays an Idempotency-Key and rejects a malformed one', async () => {
    const first = await create('SA').set('Idempotency-Key', 'job-42');
    const again = await create('SA').set('Idempotency-Key', 'job-42');
    expect(again.status).toBe(202);
    expect(again.body.runId).toBe(first.body.runId);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    await create('SA').set('Idempotency-Key', 'has space').expect(400);
  });

  it('refuses an Idempotency-Key reused for another prompt or conversation (422), replays the same request', async () => {
    h.rt.model.push({ text: 'ok' });
    const first = await create('A', { prompt: 'Count the assets' }).set(
      'Idempotency-Key',
      'k1',
    );
    await h.rt.drain();
    const conversationId = h.rt.run(first.body.runId).conversationId as string;
    const other = await create('A', { prompt: 'Delete everything' }).set(
      'Idempotency-Key',
      'k1',
    );
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
    const second = await create('A').set('Idempotency-Key', 'k2');
    await create('A', {
      prompt: 'Count the assets',
      conversationId: h.rt.run(second.body.runId).conversationId,
    })
      .set('Idempotency-Key', 'k1')
      .expect(422);
    const same = await create('A', {
      prompt: '  Count the assets ',
      conversationId,
    }).set('Idempotency-Key', 'k1');
    expect(same.status).toBe(202);
    expect(same.body.runId).toBe(first.body.runId);
    expect(h.rt.prisma.tables.aiRun.rows).toHaveLength(2);
  });

  it('continues only the caller’s own conversation (404 otherwise) and validates the body', async () => {
    const mine = await create('A');
    h.rt.model.push({ text: 'ok' });
    await h.rt.drain();
    const conversationId = h.rt.run(mine.body.runId).conversationId as string;
    const other = await create('B', { prompt: 'hi', conversationId });
    expect(other.status).toBe(404);
    const sa = await create('SA', { prompt: 'hi', conversationId });
    expect(sa.status).toBe(404);
    await create('A', { prompt: '' }).expect(400);
    await create('A', { prompt: 'x', model: 'gpt' }).expect(400);
  });

  it('answers 409 AI_DISABLED while the assistant is off', async () => {
    h.rt.settings.config = null;
    const res = await create('SA');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'AI_DISABLED' });
  });
});

describe('GET /ai/runs/:id and cancel — owner only', () => {
  it('reads the run for its owner and 404s everyone else (another user, an admin, a Service Account)', async () => {
    h.rt.model.push({ text: 'There are 3 assets.' });
    const { body } = await create('A');
    await h.rt.drain();
    const res = await http()
      .get(`/ai/runs/${body.runId}`)
      .set('X-Test-Principal', 'A');
    expect(res.status).toBe(200);
    expect(AiRunSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      id: body.runId,
      status: 'SUCCEEDED',
      finalText: 'There are 3 assets.',
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
      toolCalls: [],
      error: null,
    });
    for (const who of ['B', 'ADMIN', 'SA']) {
      const other = await http()
        .get(`/ai/runs/${body.runId}`)
        .set('X-Test-Principal', who);
      expect(other.status).toBe(404);
      expect(other.body).toEqual({
        code: 'NOT_FOUND',
        message: 'Run not found',
      });
      await http()
        .post(`/ai/runs/${body.runId}/cancel`)
        .set('X-Test-Principal', who)
        .expect(404);
    }
    await http()
      .get('/ai/runs/cnotarun00000000000000000')
      .set('X-Test-Principal', 'A')
      .expect(404);
  });

  it("cancels the owner's queued run (idempotent)", async () => {
    const { body } = await create('A');
    const res = await http()
      .post(`/ai/runs/${body.runId}/cancel`)
      .set('X-Test-Principal', 'A');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: body.runId, status: 'CANCELLED' });
    await http()
      .post(`/ai/runs/${body.runId}/cancel`)
      .set('X-Test-Principal', 'A')
      .expect(200, { runId: body.runId, status: 'CANCELLED' });
  });
});

describe('POST /ai/runs/:id/tool-calls/:toolCallId/decision', () => {
  const PASSWORD = 'correct horse';

  async function pending(tool: 'write' | 'elevated') {
    h.rt.model.push(
      {
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: TOOLS[tool].descriptor.name,
            input: { id: 'a1' },
          },
        ],
      },
      { text: 'Done.' },
    );
    const { body } = await create('A');
    await h.rt.drain();
    expect(h.rt.run(body.runId).status).toBe('AWAITING_APPROVAL');
    return body.runId as string;
  }

  function decide(runId: string, body: object, as = 'A', call = 'call_1') {
    return http()
      .post(`/ai/runs/${runId}/tool-calls/${call}/decision`)
      .set('X-Test-Principal', as)
      .send(body);
  }

  it('approves a write for the run’s own user and resumes the run', async () => {
    const runId = await pending('write');
    const res = await decide(runId, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId, status: 'QUEUED' });
    await h.rt.drain();
    expect(h.rt.run(runId).status).toBe('SUCCEEDED');
  });

  it('rejects with a reason', async () => {
    const runId = await pending('write');
    const res = await decide(runId, { decision: 'reject', reason: 'not now' });
    expect(res.status).toBe(200);
    expect(h.rt.prisma.tables.aiToolInvocation.rows[0].status).toBe('REJECTED');
  });

  it('404s another user and an admin, 403s a Service Account, and 404s an unknown call — nothing decided', async () => {
    const runId = await pending('write');
    for (const who of ['B', 'ADMIN']) {
      const res = await decide(runId, { decision: 'approve' }, who);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
    h.rt.loader.saPermissions.add('ai:use');
    const sa = await decide(runId, { decision: 'approve' }, 'SA');
    expect(sa.status).toBe(403);
    expect(sa.body).toMatchObject({ code: 'FORBIDDEN' });
    await decide(runId, { decision: 'approve' }, 'A', 'call_other').expect(404);
    expect(h.rt.tools.approved).toHaveLength(0);
    expect(h.rt.prisma.tables.aiToolInvocation.rows[0].status).toBe(
      'AWAITING_APPROVAL',
    );
  });

  it('accepts only the decision: stray fields (arguments) are a 400', async () => {
    const runId = await pending('write');
    await decide(runId, { decision: 'approve', input: { id: 'a2' } }).expect(
      400,
    );
    await decide(runId, { decision: 'maybe' }).expect(400);
    expect(h.rt.tools.approved).toHaveLength(0);
  });

  describe('password step-up (elevated)', () => {
    it('403 STEP_UP_REQUIRED without the password, 403 STEP_UP_FAILED with a wrong one — the action stays pending', async () => {
      const runId = await pending('elevated');
      const missing = await decide(runId, { decision: 'approve' });
      expect(missing.status).toBe(403);
      expect(missing.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      const wrong = await decide(runId, {
        decision: 'approve',
        password: 'nope',
      });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toMatchObject({ code: 'STEP_UP_FAILED' });
      expect(JSON.stringify(wrong.body)).not.toContain('nope');
      expect(h.rt.tools.approved).toHaveLength(0);
      expect(h.rt.prisma.tables.aiToolInvocation.rows[0].status).toBe(
        'AWAITING_APPROVAL',
      );
    });

    it('approves with the right password (stepUpVerified reaches core)', async () => {
      const runId = await pending('elevated');
      const res = await decide(runId, {
        decision: 'approve',
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(h.rt.tools.approved).toEqual([
        expect.objectContaining({ stepUpVerified: true }),
      ]);
    });

    it('429 STEP_UP_RATE_LIMITED with retryAfterSec after repeated failures', async () => {
      const runId = await pending('elevated');
      let last: request.Response | undefined;
      for (let i = 0; i < 7; i += 1) {
        last = await decide(runId, { decision: 'approve', password: 'bad' });
      }
      expect(last!.status).toBe(429);
      expect(last!.body).toMatchObject({
        code: 'STEP_UP_RATE_LIMITED',
        retryAfterSec: expect.any(Number),
      });
    });

    it('403 STEP_UP_UNAVAILABLE outside local sign-in', async () => {
      process.env.AUTH_MODE = 'oidc';
      const runId = await pending('elevated');
      const res = await decide(runId, {
        decision: 'approve',
        password: PASSWORD,
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'STEP_UP_UNAVAILABLE' });
    });
  });

  it.each([
    [
      409,
      'PREVIEW_CHANGED',
      new ConflictException({
        code: 'PREVIEW_CHANGED',
        message: 'This action changed since it was proposed; review it again',
        addedWarnings: ['CRITICAL_APPLICATION'],
      }),
    ],
    [
      403,
      'STEP_UP_REQUIRED',
      new ForbiddenException({
        code: 'STEP_UP_REQUIRED',
        message: 'This action now requires your password to be confirmed',
        addedWarnings: ['PRIVILEGE_GRANT'],
      }),
    ],
  ])(
    'passes core’s %s %s through with addedWarnings; the action stays pending',
    async (status, code, error) => {
      const runId = await pending('write');
      jest.spyOn(h.rt.tools, 'approve').mockRejectedValueOnce(error);
      const res = await decide(runId, { decision: 'approve' });
      expect(res.status).toBe(status);
      expect(res.body).toEqual(
        expect.objectContaining({
          code,
          addedWarnings: (error.getResponse() as { addedWarnings: string[] })
            .addedWarnings,
        }),
      );
      expect(h.rt.run(runId).status).toBe('AWAITING_APPROVAL');
      expect(h.rt.prisma.tables.aiToolInvocation.rows[0].status).toBe(
        'AWAITING_APPROVAL',
      );
      // The user decides again on the re-rendered card.
      await decide(runId, { decision: 'approve' }).expect(200);
    },
  );

  it('409 RUN_NOT_AWAITING_APPROVAL on a finished run, 409 AI_DISABLED while off', async () => {
    const runId = await pending('write');
    h.rt.settings.config = null;
    const off = await decide(runId, { decision: 'approve' });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ code: 'AI_DISABLED' });
    expect(h.rt.prisma.tables.aiToolInvocation.rows[0].status).toBe(
      'AWAITING_APPROVAL',
    );

    h.rt.settings.config = { ...CONFIG };
    await http()
      .post(`/ai/runs/${runId}/cancel`)
      .set('X-Test-Principal', 'A')
      .expect(200);
    const late = await decide(runId, { decision: 'approve' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'RUN_NOT_AWAITING_APPROVAL' });
  });
});
