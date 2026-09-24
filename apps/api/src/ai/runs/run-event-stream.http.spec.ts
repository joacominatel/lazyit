/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read loosely-typed SSE frames and in-memory rows; intentional for this spec file only. */
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
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AiRunEventSchema } from '@lazyit/shared';
import { HUMAN, TOOLS } from '../runtime/runtime.harness-spec';
import {
  buildHttp,
  parseSse,
  sseText,
  type HttpHarness,
} from './ai-http.harness-spec';

/**
 * `GET /ai/runs/:id/events` (W3-1; synthesis §4.6; provider-and-runtime.md §9.3; ADR-0097 decision 6): the
 * owner check BEFORE the bus, the headers the proxy relies on, replay from `Last-Event-ID`, the snapshot
 * fallback, live delivery, the close conditions, the heartbeat and teardown on disconnect.
 */

jest.setTimeout(20_000);

let h: HttpHarness;
const http = () => request(h.app.getHttpServer());

beforeAll(() => Logger.overrideLogger(false));
afterEach(() => h.close());

async function setup(options = {}) {
  h = await buildHttp(options);
}

async function startRun(steps: Parameters<HttpHarness['rt']['model']['push']>) {
  h.rt.model.push(...steps);
  const res = await http()
    .post('/ai/runs')
    .set('X-Test-Principal', 'A')
    .send({ prompt: 'Go' });
  expect(res.status).toBe(202);
  return res.body.runId as string;
}

function events(runId: string, as = 'A', lastEventId?: string) {
  const req = http()
    .get(`/ai/runs/${runId}/events`)
    .set('X-Test-Principal', as)
    .buffer(true)
    .parse(sseText as never);
  return lastEventId ? req.set('Last-Event-ID', lastEventId) : req;
}

/** Open a raw stream (no buffering) so the test can watch it live and hang up. */
async function openRaw(runId: string, as = 'A') {
  const server = h.app.getHttpServer();
  if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  let body = '';
  let req: ClientRequest | undefined;
  const res = await new Promise<IncomingMessage>((resolve) => {
    req = get(
      {
        port,
        path: `/ai/runs/${runId}/events`,
        headers: { 'X-Test-Principal': as },
      },
      resolve,
    );
  });
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    body += chunk;
  });
  res.on('error', () => undefined);
  return { res, body: () => body, hangUp: () => req!.destroy() };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function listeners(runId: string): number {
  return (
    (
      h.rt.bus as unknown as { listeners: Map<string, Set<unknown>> }
    ).listeners.get(runId)?.size ?? 0
  );
}

describe('ownership before the bus', () => {
  it('404s another user, an admin and a Service Account without touching the bus', async () => {
    await setup();
    const runId = await startRun([{ text: 'hi' }]);
    const subscribe = jest.spyOn(h.rt.bus, 'subscribe');
    const replay = jest.spyOn(h.rt.bus, 'replay');
    const lastSeq = jest.spyOn(h.rt.bus, 'lastSeq');
    h.rt.loader.saPermissions.add('ai:use');
    for (const who of ['B', 'ADMIN', 'SA']) {
      const res = await http()
        .get(`/ai/runs/${runId}/events`)
        .set('X-Test-Principal', who)
        .set('Last-Event-ID', `${runId}:1`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Run not found' });
    }
    expect(subscribe).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(lastSeq).not.toHaveBeenCalled();
  });
});

describe('snapshot and replay', () => {
  it('answers a first connection with a run.snapshot and closes on a finished run, with the streaming headers', async () => {
    await setup();
    const runId = await startRun([{ text: 'All done.' }]);
    await h.rt.drain();
    const res = await events(runId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.body.startsWith(': connected\n\n')).toBe(true);
    const frames = parseSse(res.body);
    expect(frames).toHaveLength(1);
    const [snapshot] = frames;
    expect(snapshot.event).toBe('run.snapshot');
    expect(AiRunEventSchema.safeParse(snapshot.data).success).toBe(true);
    expect(snapshot.id).toBe(`${runId}:${snapshot.data.seq}`);
    expect(snapshot.data).toMatchObject({
      v: 1,
      status: 'SUCCEEDED',
      pendingApprovals: [],
    });
    expect(snapshot.data.messages.map((m: { role: string }) => m.role)).toEqual(
      ['user', 'assistant'],
    );
    expect(res.body).not.toContain('lazyit-');
  });

  it('snapshots a run waiting for approval with its stored preview, then closes', async () => {
    await setup();
    const runId = await startRun([
      {
        toolCalls: [
          {
            toolCallId: 'w1',
            toolName: TOOLS.write.descriptor.name,
            input: { id: 'a1' },
          },
        ],
      },
    ]);
    await h.rt.drain();
    const frames = parseSse((await events(runId)).body);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toMatchObject({
      status: 'AWAITING_APPROVAL',
      pendingApprovals: [
        {
          toolCallId: 'w1',
          elevated: false,
          preview: { toolName: 'update_asset' },
        },
      ],
    });
  });

  it('replays the events after Last-Event-ID (increasing, not consecutive) and closes on run.finished', async () => {
    await setup();
    const runId = await startRun([{ text: 'Hello', deltas: ['Hel', 'lo'] }]);
    await h.rt.drain();
    const all = parseSse((await events(runId, 'A', `${runId}:0`)).body);
    // `0` is below the buffer's floor here only if the base moved; the harness bus starts at 0, so this is
    // a full replay.
    expect(all[0].event).not.toBe('run.snapshot');
    const seqs = all.map((f) => Number(f.id!.split(':')[1]));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(all[all.length - 1].event).toBe('run.finished');

    const from = all[1].id!;
    const rest = parseSse((await events(runId, 'A', from)).body);
    expect(rest.map((f) => f.id)).toEqual(all.slice(2).map((f) => f.id));
    for (const frame of rest) {
      expect(Number(frame.id!.split(':')[1])).toBeGreaterThan(
        Number(from.split(':')[1]),
      );
      expect(AiRunEventSchema.safeParse(frame.data).success).toBe(true);
    }
  });

  it('closes at once when the replay is already complete (Last-Event-ID = run.finished)', async () => {
    await setup();
    const runId = await startRun([{ text: 'x' }]);
    await h.rt.drain();
    const all = parseSse((await events(runId, 'A', `${runId}:0`)).body);
    const res = await events(runId, 'A', all[all.length - 1].id);
    expect(parseSse(res.body)).toEqual([]);
  });

  it('falls back to a snapshot for a position the buffer does not hold (another process, another run, garbage)', async () => {
    await setup();
    const runId = await startRun([{ text: 'x' }]);
    await h.rt.drain();
    for (const header of [
      `${runId}:999999999`,
      `cother000000000000000000001:1`,
      'garbage',
    ]) {
      const frames = parseSse((await events(runId, 'A', header)).body);
      expect(frames.map((f) => f.event)).toEqual(['run.snapshot']);
    }
  });
});

describe('live delivery', () => {
  it('delivers events published after the connection until run.finished, and then closes', async () => {
    await setup();
    const runId = await startRun([
      { text: 'Live answer', deltas: ['Live ', 'answer'] },
    ]);
    const subscribe = h.rt.bus.subscribe.bind(h.rt.bus);
    jest.spyOn(h.rt.bus, 'subscribe').mockImplementation((id, listener) => {
      const off = subscribe(id, listener);
      setTimeout(() => void h.rt.drain(), 10);
      return off;
    });
    const frames = parseSse((await events(runId)).body);
    const types = frames.map((f) => f.event);
    expect(types[0]).toBe('run.snapshot');
    expect(frames[0].data.status).toBe('QUEUED');
    expect(types).toEqual(
      expect.arrayContaining([
        'message.delta',
        'message.completed',
        'run.finished',
      ]),
    );
    expect(types[types.length - 1]).toBe('run.finished');
    const deltas = frames
      .filter((f) => f.event === 'message.delta')
      .map((f) => f.data.text as string)
      .join('');
    expect(deltas).toBe('Live answer');
    expect(listeners(runId)).toBe(0);
  });

  it('closes after AWAITING_APPROVAL; the client re-subscribes after deciding', async () => {
    await setup();
    const runId = await startRun([
      {
        toolCalls: [
          {
            toolCallId: 'w1',
            toolName: TOOLS.write.descriptor.name,
            input: {},
          },
        ],
      },
      { text: 'Done.' },
    ]);
    const subscribe = h.rt.bus.subscribe.bind(h.rt.bus);
    const spy = jest
      .spyOn(h.rt.bus, 'subscribe')
      .mockImplementation((id, listener) => {
        const off = subscribe(id, listener);
        setTimeout(() => void h.rt.drain(), 10);
        return off;
      });
    const first = parseSse((await events(runId)).body);
    const last = first[first.length - 1];
    expect(last).toMatchObject({
      event: 'run.status',
      data: { status: 'AWAITING_APPROVAL' },
    });
    expect(first.map((f) => f.event)).toContain('tool.approval_required');

    await http()
      .post(`/ai/runs/${runId}/tool-calls/w1/decision`)
      .set('X-Test-Principal', 'A')
      .send({ decision: 'approve' })
      .expect(200);
    spy.mockRestore();
    const subscribe2 = h.rt.bus.subscribe.bind(h.rt.bus);
    jest.spyOn(h.rt.bus, 'subscribe').mockImplementation((id, listener) => {
      const off = subscribe2(id, listener);
      setTimeout(() => void h.rt.drain(), 10);
      return off;
    });
    const second = parseSse((await events(runId, 'A', last.id)).body);
    const types = second.map((f) => f.event);
    expect(types).toContain('tool.approval_resolved');
    expect(types[types.length - 1]).toBe('run.finished');
  });
});

describe('connection lifecycle', () => {
  it('sends heartbeats and tears everything down when the client hangs up', async () => {
    await setup({ heartbeatMs: 20 });
    const runId = await startRun([{ text: 'never drained' }]);
    const stream = await openRaw(runId);
    expect(stream.res.statusCode).toBe(200);
    await until(() => stream.body().includes(': heartbeat'));
    expect(listeners(runId)).toBe(1);
    expect(h.stream.openFor(HUMAN)).toBe(1);

    stream.hangUp();
    await until(() => listeners(runId) === 0 && h.stream.openFor(HUMAN) === 0);
    // The run is untouched by the disconnect.
    expect(h.rt.run(runId).status).toBe('QUEUED');
  });

  it('closes a stream after its maximum lifetime (the client resumes with Last-Event-ID)', async () => {
    await setup({ maxLifetimeMs: 50 });
    const runId = await startRun([{ text: 'never drained' }]);
    const res = await events(runId);
    expect(parseSse(res.body).map((f) => f.event)).toEqual(['run.snapshot']);
    expect(listeners(runId)).toBe(0);
    expect(h.stream.openFor(HUMAN)).toBe(0);
  });

  it('caps open streams per principal (429 RATE_LIMITED) and frees the slot on disconnect', async () => {
    await setup({ maxPerPrincipal: 1 });
    const runId = await startRun([{ text: 'never drained' }]);
    const first = await openRaw(runId);
    await until(() => h.stream.openFor(HUMAN) === 1);
    const refused = await http()
      .get(`/ai/runs/${runId}/events`)
      .set('X-Test-Principal', 'A');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });
    first.hangUp();
    await until(() => h.stream.openFor(HUMAN) === 0);
  });
});
