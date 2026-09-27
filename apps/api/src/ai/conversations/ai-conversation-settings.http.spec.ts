/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- assertions read loosely-typed HTTP bodies and in-memory rows; intentional for this spec file only. */
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
import {
  AiConversationDetailSchema,
  AiConversationSettingsSchema,
  AiModelCatalogSchema,
} from '@lazyit/shared';
import { AiProviderError } from '../providers/ai-provider.error';
import { buildHttp, type HttpHarness } from '../runs/ai-http.harness-spec';
import { TOOLS, USER_ID } from '../runtime/runtime.harness-spec';

/**
 * Per-conversation settings over HTTP (#1373 model and reasoning, #1376 auto-approve): the create body,
 * `PATCH /ai/conversations/:id` and its pin rule, the auto-approved transcript, and `GET /ai/models`.
 */

let h: HttpHarness;
const http = () => request(h.app.getHttpServer());

beforeAll(() => Logger.overrideLogger(false));
beforeEach(async () => {
  h = await buildHttp();
});
afterEach(() => h.close());

async function create(body?: object, as = 'A'): Promise<request.Response> {
  const req = http().post('/ai/conversations').set('X-Test-Principal', as);
  return body === undefined ? req : req.send(body);
}

async function settingsOf(id: string) {
  const res = await http()
    .get(`/ai/conversations/${id}`)
    .set('X-Test-Principal', 'A')
    .expect(200);
  expect(AiConversationDetailSchema.safeParse(res.body).success).toBe(true);
  return res.body.settings;
}

function patch(id: string, body: object, as = 'A') {
  return http()
    .patch(`/ai/conversations/${id}`)
    .set('X-Test-Principal', as)
    .send(body);
}

async function say(id: string, text = 'Hi') {
  return http()
    .post(`/ai/conversations/${id}/messages`)
    .set('X-Test-Principal', 'A')
    .send({ text });
}

describe('create with settings', () => {
  it('keeps the instance defaults with no body (the pre-#1373 client)', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(await settingsOf(res.body.id)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      modelChosen: false,
      effort: null,
      providerOptions: null,
      modelLocked: false,
      autoApprove: false,
      autoApproveEnabledAt: null,
    });
  });

  it('pins the chosen model and effort, and records auto-approve with its time', async () => {
    const res = await create({
      model: 'claude-haiku-5',
      effort: 'low',
      autoApprove: true,
    });
    expect(res.status).toBe(201);
    const settings = await settingsOf(res.body.id);
    expect(settings).toMatchObject({
      model: 'claude-haiku-5',
      modelChosen: true,
      effort: 'low',
      autoApprove: true,
      autoApproveEnabledAt: expect.any(String),
    });
    expect(h.rt.prisma.tables.aiConfigAuditLog.rows).toHaveLength(1);
  });

  it('validates the body: an unsafe model id, an unknown field, an effort the provider does not take', async () => {
    for (const model of ['../../v1/files', 'model?key=x', 'a b', '']) {
      expect((await create({ model })).status).toBe(400);
    }
    expect((await create({ temperature: 1 })).status).toBe(400);
    expect(
      (await create({ model: 'meta-llama/Llama-3.3-70B:latest' })).status,
    ).toBe(201);
    h.rt.settings.config = {
      ...h.rt.settings.config!,
      provider: 'openai-compatible',
    };
    const refused = await create({ effort: 'high' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'EFFORT_UNSUPPORTED' });
    expect(
      (await create({ providerOptions: { temperature: 0.2 } })).status,
    ).toBe(201);
  });
});

describe('PATCH /ai/conversations/:id', () => {
  it('changes the model until the first run starts, then refuses (CONVERSATION_SETTINGS_LOCKED)', async () => {
    const { body } = await create();
    let res = await patch(body.id, {
      model: 'claude-haiku-5',
      effort: 'high',
    });
    expect(res.status).toBe(200);
    expect(AiConversationSettingsSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      model: 'claude-haiku-5',
      modelChosen: true,
      effort: 'high',
      modelLocked: false,
    });

    h.rt.model.push({ text: 'Hello.' });
    await say(body.id);
    await h.rt.drain();
    expect(h.rt.model.requests[0]).toMatchObject({
      model: { modelId: 'claude-haiku-5' },
      effort: 'high',
    });

    res = await patch(body.id, { model: 'claude-opus-5' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONVERSATION_SETTINGS_LOCKED' });
    expect((await settingsOf(body.id)).model).toBe('claude-haiku-5');
    expect((await settingsOf(body.id)).modelLocked).toBe(true);
  });

  it('toggles auto-approve at any time, and audits each change', async () => {
    const { body } = await create();
    h.rt.model.push({ text: 'Hello.' });
    await say(body.id);
    await h.rt.drain();

    let res = await patch(body.id, { autoApprove: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      autoApprove: true,
      autoApproveEnabledAt: expect.any(String),
      modelLocked: true,
    });
    res = await patch(body.id, { autoApprove: true }); // no change, no audit row
    res = await patch(body.id, { autoApprove: false });
    expect(res.body).toMatchObject({
      autoApprove: false,
      autoApproveEnabledAt: null,
    });
    expect(h.auditRows).toEqual([
      expect.objectContaining({
        action: 'CONVERSATION_AUTO_APPROVE_CHANGED',
        actorId: USER_ID,
        detail: { conversationId: body.id, before: false, after: true },
      }),
      expect.objectContaining({
        detail: { conversationId: body.id, before: true, after: false },
      }),
    ]);
  });

  it('is owner only (404), human only (403), and validates the body', async () => {
    const { body } = await create();
    expect((await patch(body.id, { autoApprove: true }, 'B')).status).toBe(404);
    expect((await patch(body.id, { autoApprove: true }, 'ADMIN')).status).toBe(
      404,
    );
    h.rt.loader.saPermissions.add('ai:use');
    expect((await patch(body.id, { autoApprove: true }, 'SA')).status).toBe(
      403,
    );
    expect((await patch(body.id, {})).status).toBe(400);
    expect((await patch(body.id, { model: '../x' })).status).toBe(400);
    expect(
      (await patch(body.id, { providerOptions: { temperature: 1 } })).body,
    ).toMatchObject({ code: 'PROVIDER_OPTIONS_UNSUPPORTED' });
    expect(h.auditRows).toHaveLength(0);
  });

  it('refuses model changes while AI is off, but still lets the owner switch auto-approve off', async () => {
    const { body } = await create({ autoApprove: true });
    h.rt.settings.config = null;
    expect(
      (await patch(body.id, { model: 'claude-haiku-5' })).body,
    ).toMatchObject({ code: 'AI_DISABLED' });
    const res = await patch(body.id, { autoApprove: false });
    expect(res.status).toBe(200);
    expect(res.body.autoApprove).toBe(false);
  });
});

describe('auto-approved writes in the transcript', () => {
  it('shows the card as approved automatically', async () => {
    const { body } = await create({ autoApprove: true });
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
    await say(body.id, 'Retire a1');
    await h.rt.drain();
    const res = await http()
      .get(`/ai/conversations/${body.id}`)
      .set('X-Test-Principal', 'A');
    expect(res.body.status).toBe('idle');
    expect(res.body.messages[1].parts[1]).toMatchObject({
      type: 'approval',
      outcome: 'approved',
      auto: true,
    });
    expect(AiConversationDetailSchema.safeParse(res.body).success).toBe(true);
  });
});

describe('GET /ai/models', () => {
  it('lists the provider models for an ai:use holder, with the default and what the provider takes', async () => {
    const res = await http()
      .get('/ai/models')
      .set('X-Test-Principal', 'A')
      .expect(200);
    expect(AiModelCatalogSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toEqual({
      provider: 'anthropic',
      defaultModel: 'claude-opus-5',
      defaultEffort: null,
      supportsEffort: true,
      providerOptionKeys: [],
      models: [
        { id: 'claude-opus-5', label: 'Claude Opus 5' },
        { id: 'claude-haiku-5', label: null },
      ],
      listed: true,
      listingError: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-test');
  });

  it('caches the listing across callers', async () => {
    await http().get('/ai/models').set('X-Test-Principal', 'A').expect(200);
    await http().get('/ai/models').set('X-Test-Principal', 'B').expect(200);
    expect(h.models.calls).toBe(1);
    // A new connection (another key) is listed again.
    h.rt.settings.config = { ...h.rt.settings.config!, apiKey: 'sk-other' };
    await http().get('/ai/models').set('X-Test-Principal', 'A').expect(200);
    expect(h.models.calls).toBe(2);
  });

  it('answers listed: false with the default when the provider cannot be listed', async () => {
    h.models.next = () => Promise.reject(new AiProviderError('PROVIDER_AUTH'));
    const res = await http()
      .get('/ai/models')
      .set('X-Test-Principal', 'A')
      .expect(200);
    expect(res.body).toMatchObject({
      listed: false,
      listingError: 'PROVIDER_AUTH',
      models: [{ id: 'claude-opus-5', label: null }],
    });
  });

  it('refuses without ai:use, a Service Account, anonymous, and answers 409 while AI is off', async () => {
    h.rt.loader.saPermissions.add('ai:use');
    await http().get('/ai/models').set('X-Test-Principal', 'SA').expect(403);
    await http().get('/ai/models').expect(403);
    h.rt.settings.config = null;
    const off = await http().get('/ai/models').set('X-Test-Principal', 'A');
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ code: 'AI_DISABLED' });
    h.rt.permissions.memberPermissions.delete('ai:use');
    await http().get('/ai/models').set('X-Test-Principal', 'A').expect(403);
    expect(h.models.calls).toBe(0);
  });
});
