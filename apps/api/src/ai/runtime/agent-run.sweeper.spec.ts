/* eslint-disable @typescript-eslint/no-unsafe-member-access -- assertions read the loosely-typed rows and provider messages of the in-memory test database; intentional for this spec file only. */
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
import type { Job } from 'bullmq';
import { AI_RUN_JOB_RESUME, AI_RUN_JOB_START } from '../ai.constants';
import type { AgentLoop } from './agent-loop';
import { AgentRunWorker } from './agent-run.worker';
import { AiRunQueue, type AiRunJobData } from './run-queue';
import {
  aiRunJobId,
  aiWorkerConcurrency,
  AI_WORKER_CONCURRENCY_DEFAULT,
} from './runtime.constants';
import {
  buildRuntime,
  HUMAN,
  SERVICE,
  TOOLS,
  type Runtime,
} from './runtime.harness-spec';

/**
 * The `ai-run` worker, the queue producer and the sweeper (provider-and-runtime.md §8 invariant 7;
 * ADR-0053): jobs carry only `{ runId }` and are never retried; a restart mid-run recovers without
 * executing a write twice; an interrupted execution becomes OUTCOME_UNKNOWN.
 */

const WRITE = TOOLS.write.descriptor.name;
const MIN = 60 * 1000;

let rt: Runtime;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  rt = buildRuntime();
});

/** Let pending promise chains settle (the hung "dead process" never does). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('AiRunQueue (producer)', () => {
  it('enqueues a job that carries only the run id, never retried', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = new AiRunQueue({ add } as never);
    await queue.enqueueStart('run1');
    await queue.enqueueResume('run1', 3);
    expect(add).toHaveBeenNthCalledWith(
      1,
      AI_RUN_JOB_START,
      { runId: 'run1' },
      expect.objectContaining({ jobId: 'start-run1', attempts: 1 }),
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      AI_RUN_JOB_RESUME,
      { runId: 'run1' },
      expect.objectContaining({ jobId: 'resume-run1-3', attempts: 1 }),
    );
  });

  it('swallows a broker failure (the sweeper recovers the run)', async () => {
    const add = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('down'), { code: 'ECONNREFUSED' }),
      );
    const queue = new AiRunQueue({ add } as never);
    await expect(queue.enqueueStart('run1')).resolves.toBe(false);
  });

  it('reads in-flight run ids, or null when the broker is unreadable', async () => {
    const getJobs = jest
      .fn()
      .mockResolvedValueOnce([{ data: { runId: 'a' } }, { data: {} }, null])
      .mockRejectedValueOnce(new Error('down'));
    const queue = new AiRunQueue({ getJobs } as never);
    await expect(queue.inFlightRunIds()).resolves.toEqual(new Set(['a']));
    await expect(queue.inFlightRunIds()).resolves.toBeNull();
  });

  it('builds BullMQ-safe job ids', () => {
    expect(aiRunJobId('resume', 'a:b', 2)).toBe('resume-a-b-2');
  });

  it('reads AI_WORKER_CONCURRENCY, bounded', () => {
    expect(aiWorkerConcurrency(undefined)).toBe(AI_WORKER_CONCURRENCY_DEFAULT);
    expect(aiWorkerConcurrency('8')).toBe(8);
    expect(aiWorkerConcurrency('0')).toBe(AI_WORKER_CONCURRENCY_DEFAULT);
    expect(aiWorkerConcurrency('abc')).toBe(AI_WORKER_CONCURRENCY_DEFAULT);
    expect(aiWorkerConcurrency('999')).toBe(16);
  });
});

describe('AgentRunWorker', () => {
  function job(name: string, data: unknown): Job<AiRunJobData> {
    return { name, data } as Job<AiRunJobData>;
  }

  it('drives the run named by the job, and never rethrows', async () => {
    const advance = jest.fn().mockRejectedValue(new Error('db down'));
    const worker = new AgentRunWorker({ advance } as unknown as AgentLoop);
    await expect(
      worker.process(job(AI_RUN_JOB_START, { runId: 'r1' })),
    ).resolves.toBeUndefined();
    await worker.process(job(AI_RUN_JOB_RESUME, { runId: 'r1' }));
    expect(advance).toHaveBeenCalledTimes(2);
    expect(advance).toHaveBeenCalledWith('r1');
  });

  it('ignores a job without a run id or with an unknown name', async () => {
    const advance = jest.fn();
    const worker = new AgentRunWorker({ advance } as unknown as AgentLoop);
    await worker.process(job(AI_RUN_JOB_START, {}));
    await worker.process(job('other', { runId: 'r1' }));
    expect(advance).not.toHaveBeenCalled();
  });

  it('a duplicate job for a run already running does nothing', async () => {
    rt.model.push({ text: 'ok' });
    const { runId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    await rt.loop.advance(runId);
    await rt.loop.advance(runId); // re-delivery after completion
    expect(rt.model.requests).toHaveLength(1);
    expect(rt.run(runId).status).toBe('SUCCEEDED');
  });
});

describe('crash recovery', () => {
  it('a restart mid-run never executes the interrupted write again', async () => {
    rt.tools.hangOnWrite = true;
    rt.model.push({
      toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
    });
    const { runId, conversationId } = await rt.orchestrator.submit({
      identity: SERVICE,
      channel: 'HEADLESS',
      text: 'Retire LZ-0001',
    });
    rt.queue.jobs.length = 0;
    void rt.loop.advance(runId); // the process dies inside the write
    await settle();
    expect(rt.run(runId).status).toBe('RUNNING');
    expect(rt.prisma.tables.aiToolInvocation.rows[0].status).toBe('EXECUTING');
    expect(rt.tools.invoked).toHaveLength(1);

    // Still alive in this process (a slow write): the sweeper never touches it, job or no job.
    rt.queue.inFlight = new Set();
    expect(
      (await rt.sweeper.sweep(new Date(Date.now() + 6 * MIN))).failedStale,
    ).toBe(0);
    expect(rt.run(runId).status).toBe('RUNNING');

    rt.restart();
    // After the restart BullMQ re-delivers the stalled job: the run is not QUEUED, nothing runs.
    await rt.loop.advance(runId);
    expect(rt.tools.invoked).toHaveLength(1);

    // While the job is still in flight the sweeper leaves the run alone.
    rt.queue.inFlight = new Set([runId]);
    const early = await rt.sweeper.sweep(new Date(Date.now() + 6 * MIN));
    expect(early.failedStale).toBe(0);

    // Once no job owns it: OUTCOME_UNKNOWN, FAILED ENGINE_RESTART, every call answered, no re-execution.
    rt.queue.inFlight = new Set();
    const swept = await rt.sweeper.sweep(new Date(Date.now() + 6 * MIN));
    expect(swept.failedStale).toBe(1);
    expect(rt.prisma.tables.aiToolInvocation.rows[0].status).toBe(
      'OUTCOME_UNKNOWN',
    );
    expect(rt.run(runId)).toMatchObject({
      status: 'FAILED',
      finishReason: 'engine_restart',
      error: { code: 'ENGINE_RESTART' },
    });
    const tool = rt.transcript(conversationId).at(-1)!;
    expect(tool.role).toBe('tool');
    expect(tool.content[0]).toMatchObject({ toolCallId: 'w', isError: true });
    expect(tool.content[0].output.error.code).toBe('UNKNOWN_OUTCOME');
    expect(rt.tools.invoked).toHaveLength(1);
    expect(rt.queue.jobs).toHaveLength(0);
  });

  it('skips the RUNNING reconciler when the broker cannot be read', async () => {
    rt.tools.hangOnWrite = true;
    rt.model.push({
      toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
    });
    const { runId } = await rt.orchestrator.submit({
      identity: SERVICE,
      channel: 'HEADLESS',
      text: 'x',
    });
    rt.queue.jobs.length = 0;
    void rt.loop.advance(runId);
    await settle();
    rt.restart();
    rt.queue.inFlight = null;
    const swept = await rt.sweeper.sweep(new Date(Date.now() + 6 * MIN));
    expect(swept.failedStale).toBe(0);
    expect(rt.run(runId).status).toBe('RUNNING');
  });

  it('an approved write stuck EXECUTING becomes OUTCOME_UNKNOWN and the run resumes', async () => {
    rt.model.push(
      {
        toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
      },
      { text: 'I could not confirm the change.' },
    );
    const { runId, conversationId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'Retire it',
    });
    await rt.drain();
    // The process died inside `approve`, after the claim: the row is EXECUTING, the run still waiting.
    const row = rt.prisma.tables.aiToolInvocation.rows[0];
    row.status = 'EXECUTING';

    const swept = await rt.sweeper.sweep(new Date(Date.now() + 6 * MIN));
    expect(swept.outcomeUnknown).toBe(1);
    expect(swept.resumed).toBe(1);
    expect(row.status).toBe('OUTCOME_UNKNOWN');
    expect(rt.run(runId).status).toBe('QUEUED');
    expect(rt.queue.jobs[0]).toMatchObject({ name: 'resume', runId });
    expect(rt.queue.jobs[0].jobId).toMatch(
      new RegExp(`^resume-${runId}-sweep-\\d+$`),
    );

    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');
    const results = rt
      .transcript(conversationId)
      .find((m) => m.role === 'tool')!;
    expect(results.content[0].output.error.code).toBe('UNKNOWN_OUTCOME');
    expect(rt.tools.approved).toHaveLength(0);
  });

  it('re-enqueues a lost resume', async () => {
    rt.model.push(
      {
        toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
      },
      { text: 'done' },
    );
    const { runId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    await rt.drain();
    rt.queue.down = true; // the resume enqueue is lost
    await rt.approvals.decide({
      runId,
      toolCallId: 'w',
      decision: 'approve',
      identity: HUMAN,
    });
    expect(rt.run(runId).status).toBe('QUEUED');
    expect(rt.queue.jobs).toHaveLength(0);

    rt.queue.down = false;
    const swept = await rt.sweeper.sweep(new Date(Date.now() + 2 * MIN));
    expect(swept.requeued).toBe(1);
    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');
    expect(rt.tools.approved).toHaveLength(1);
  });

  it('re-enqueues a run whose start job never reached the queue', async () => {
    rt.queue.down = true;
    rt.model.push({ text: 'ok' });
    const { runId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    rt.queue.down = false;
    expect(rt.queue.jobs).toHaveLength(0);
    // Too early: a healthy enqueue is never double-fired.
    expect((await rt.sweeper.sweep(new Date())).requeued).toBe(0);
    const swept = await rt.sweeper.sweep(new Date(Date.now() + MIN));
    expect(swept.requeued).toBe(1);
    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');
  });

  it('cancels a waiting run once AI is turned off', async () => {
    rt.model.push({
      toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
    });
    const { runId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    await rt.drain();
    rt.settings.config = null;
    const swept = await rt.sweeper.sweep(new Date(Date.now() + 2 * MIN));
    expect(swept.cancelled).toBe(1);
    expect(rt.run(runId)).toMatchObject({
      status: 'CANCELLED',
      error: { code: 'AI_DISABLED' },
    });
    expect(rt.prisma.tables.aiToolInvocation.rows[0].status).toBe('CANCELLED');
  });

  it('cancels a waiting run whose user signed out (session epoch bumped)', async () => {
    rt.model.push({
      toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
    });
    const { runId } = await rt.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    await rt.drain();
    rt.loader.user.sessionEpoch += 1;
    const swept = await rt.sweeper.sweep(new Date(Date.now() + 2 * MIN));
    expect(swept.cancelled).toBe(1);
    expect(rt.run(runId)).toMatchObject({
      status: 'CANCELLED',
      error: { code: 'FORBIDDEN' },
    });
  });
});
