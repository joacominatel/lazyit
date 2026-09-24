/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- assertions read loosely-typed HTTP bodies and in-memory rows; intentional for this spec file only. */
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
import { SA_ID, TOOLS } from '../runtime/runtime.harness-spec';
import {
  ADMIN_ID,
  buildHttp,
  type HttpHarness,
} from '../runs/ai-http.harness-spec';
import { AI_SA_ACCESS_AUDIT_ACTION } from './ai-service-account-access.service';

/**
 * `GET` / `PUT /config/ai/service-accounts/:id` (W3-1; synthesis §4.7; frontend.md K2): the AI configuration
 * gate (settings:manage, humans only), the audited write, read tolerance — and that the runtime enforces
 * what is saved on the next headless run.
 */

let h: HttpHarness;
const http = () => request(h.app.getHttpServer());
const path = `/config/ai/service-accounts/${SA_ID}`;

beforeAll(() => Logger.overrideLogger(false));
beforeEach(async () => {
  h = await buildHttp();
});
afterEach(() => h.close());

function put(body: object, as = 'ADMIN') {
  return http().put(path).set('X-Test-Principal', as).send(body);
}

describe('the gate', () => {
  it('refuses a member (403) and a Service Account even holding settings:manage (403)', async () => {
    for (const as of ['A', 'SA_ADMIN']) {
      await http().get(path).set('X-Test-Principal', as).expect(403);
      await put({ access: 'off', maxMutationsPerRun: null }, as).expect(403);
    }
    expect(h.auditRows).toHaveLength(0);
    expect(h.rt.prisma.tables.aiServiceAccountSettings.rows).toHaveLength(0);
  });

  it('404s an unknown or revoked Service Account and a malformed id', async () => {
    h.serviceAccounts.delete(SA_ID);
    await http().get(path).set('X-Test-Principal', 'ADMIN').expect(404);
    await put({ access: 'off', maxMutationsPerRun: null }).expect(404);
    await http()
      .get('/config/ai/service-accounts/not-an-id!')
      .set('X-Test-Principal', 'ADMIN')
      .expect(404);
    expect(h.auditRows).toHaveLength(0);
  });
});

describe('read and write', () => {
  it('reads an account never configured as read-write with no cap', async () => {
    await http()
      .get(path)
      .set('X-Test-Principal', 'ADMIN')
      .expect(200, { access: 'read-write', maxMutationsPerRun: null });
  });

  it('saves the setting and audits it once, with the author and the before/after', async () => {
    const res = await put({ access: 'read-only', maxMutationsPerRun: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access: 'read-only', maxMutationsPerRun: 5 });
    expect(h.rt.prisma.tables.aiServiceAccountSettings.rows).toEqual([
      expect.objectContaining({
        serviceAccountId: SA_ID,
        access: 'read-only',
        maxMutationsPerRun: 5,
      }),
    ]);
    expect(h.auditRows).toEqual([
      expect.objectContaining({
        action: AI_SA_ACCESS_AUDIT_ACTION,
        actorId: ADMIN_ID,
        targetServiceAccountId: SA_ID,
        detail: {
          before: { access: 'read-write', maxMutationsPerRun: null },
          after: { access: 'read-only', maxMutationsPerRun: 5 },
        },
      }),
    ]);

    // Unchanged → no write, no audit row.
    await put({ access: 'read-only', maxMutationsPerRun: 5 }).expect(200);
    expect(h.auditRows).toHaveLength(1);

    await put({ access: 'off', maxMutationsPerRun: null }).expect(200);
    expect(h.auditRows).toHaveLength(2);
    expect(h.auditRows[1].detail).toEqual({
      before: { access: 'read-only', maxMutationsPerRun: 5 },
      after: { access: 'off', maxMutationsPerRun: null },
    });
    await http()
      .get(path)
      .set('X-Test-Principal', 'ADMIN')
      .expect(200, { access: 'off', maxMutationsPerRun: null });
  });

  it('validates on write (400) and stays tolerant on read', async () => {
    await put({ access: 'admin', maxMutationsPerRun: null }).expect(400);
    await put({ access: 'off', maxMutationsPerRun: 0 }).expect(400);
    await put({ access: 'off' }).expect(400);
    await put({ access: 'off', maxMutationsPerRun: null, x: 1 }).expect(400);
    expect(h.auditRows).toHaveLength(0);

    // A value from a newer build reads restrictively, a malformed cap as none.
    h.rt.prisma.tables.aiServiceAccountSettings.rows.push({
      serviceAccountId: SA_ID,
      access: 'read-write-plus',
      maxMutationsPerRun: -3,
    });
    await http()
      .get(path)
      .set('X-Test-Principal', 'ADMIN')
      .expect(200, { access: 'read-only', maxMutationsPerRun: null });
  });
});

describe('what the runtime does with it (POST /ai/runs as the Service Account)', () => {
  it('off → 403; read-only → no write tool; read-write with a cap → the cap refuses the extra write', async () => {
    await put({ access: 'off', maxMutationsPerRun: null }).expect(200);
    await http()
      .post('/ai/runs')
      .set('X-Test-Principal', 'SA')
      .send({ prompt: 'go' })
      .expect(403);

    await put({ access: 'read-only', maxMutationsPerRun: null }).expect(200);
    const ro = await http()
      .post('/ai/runs')
      .set('X-Test-Principal', 'SA')
      .send({ prompt: 'go' });
    expect(ro.status).toBe(202);
    const conv = h.rt.prisma.tables.aiConversation.rows.find(
      (r) => r.id === h.rt.run(ro.body.runId).conversationId,
    )!;
    expect(conv.toolNames).not.toContain(TOOLS.write.descriptor.name);

    await put({ access: 'read-write', maxMutationsPerRun: 1 }).expect(200);
    h.rt.model.push(
      { text: 'noop' }, // the read-only run above
      {
        toolCalls: [
          {
            toolCallId: 'w1',
            toolName: TOOLS.write.descriptor.name,
            input: {},
          },
          {
            toolCallId: 'w2',
            toolName: TOOLS.write.descriptor.name,
            input: {},
          },
        ],
      },
      { text: 'Done.' },
    );
    await h.rt.drain();
    const rw = await http()
      .post('/ai/runs')
      .set('X-Test-Principal', 'SA')
      .set('Idempotency-Key', 'capped')
      .send({ prompt: 'write twice' });
    expect(rw.status).toBe(202);
    await h.rt.drain();
    const run = await http()
      .get(`/ai/runs/${rw.body.runId}`)
      .set('X-Test-Principal', 'SA');
    expect(run.body.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'w1', status: 'SUCCEEDED' }),
      expect.objectContaining({ toolCallId: 'w2', status: 'FAILED' }),
    ]);
  });
});
