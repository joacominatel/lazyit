/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- assertions read the loosely-typed rows and provider messages of the in-memory test database; intentional for this spec file only. */
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
import { AiMessagePartSchema, AiRunEventSchema } from '@lazyit/shared';
import { projectTranscript } from '../conversations/transcript-projection';
import {
  buildRuntime,
  FAKE_FORM,
  HUMAN,
  OTHER_USER_ID,
  SERVICE,
  TOOLS,
  type Runtime,
} from './runtime.harness-spec';

/**
 * Input requests end to end (#1388): the assistant asks the user for missing data with a form; the run
 * pauses AWAITING_INPUT, the owner answers through the input endpoint's service, and the answer is the
 * tool result the model continues from. Real orchestrator, loop, lifecycle, sweeper and input service
 * over the in-memory database of the runtime harness.
 */

const ASK = TOOLS.input.descriptor.name;
const READ = TOOLS.read.descriptor.name;
const WRITE = TOOLS.write.descriptor.name;

let rt: Runtime;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  rt = buildRuntime();
});

async function chat(text = 'Add the new laptops') {
  return rt.orchestrator.submit({
    identity: HUMAN,
    channel: 'CHAT',
    text,
  });
}

function status(runId: string) {
  return rt.run(runId).status as string;
}

function toolMessages(conversationId: string) {
  return rt
    .transcript(conversationId)
    .filter((m) => m.role === 'tool')
    .map(
      (m) =>
        m.content as Array<{
          toolCallId: string;
          output: any;
          isError: boolean;
        }>,
    );
}

function inputRow() {
  return rt.prisma.tables.aiToolInvocation.rows.find(
    (r) => r.toolName === ASK,
  )!;
}

async function refusedWith(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return {
      status: e.getStatus(),
      body: e.getResponse() as { code: string; issues?: unknown[] },
    };
  }
  throw new Error('expected a refusal');
}

/** A run paused on the fake form (`ask_user`), next to a read in the same step. */
async function paused() {
  rt.model.push(
    {
      toolCalls: [
        { toolCallId: 'call_r', toolName: READ, input: { q: 'laptop' } },
        { toolCallId: 'call_ask', toolName: ASK, input: { title: 'x' } },
      ],
    },
    { text: 'Thanks, creating them now.' },
  );
  const accepted = await chat();
  await rt.drain();
  return accepted;
}

const VALID = {
  action: 'submit' as const,
  values: { manufacturer: 'Dell', notes: '  for the new hires  ' },
  groups: { models: [{ name: 'Latitude 5450', count: '4' }] },
};

describe('request_input: pause AWAITING_INPUT → answer → resume', () => {
  it('pauses on the form, announces it, and resumes with the user-provided answer as the result', async () => {
    const { runId, conversationId } = await paused();

    expect(status(runId)).toBe('AWAITING_INPUT');
    expect(rt.queue.jobs).toHaveLength(0);
    const row = inputRow();
    expect(row).toMatchObject({
      status: 'AWAITING_INPUT',
      toolUseId: 'call_ask',
      toolClass: 'navigate',
      runId,
    });
    const events = rt.events(runId);
    // Every event is on the contract.
    for (const event of events) {
      expect(AiRunEventSchema.safeParse(event).success).toBe(true);
    }
    const required = events.find((e) => e.type === 'input.required');
    expect(required).toMatchObject({ toolCallId: 'call_ask', form: FAKE_FORM });
    expect(
      events.find((e) => e.type === 'tool.call' && e.toolCallId === 'call_ask'),
    ).toMatchObject({ status: 'AWAITING_INPUT', kind: 'navigate' });
    expect(events.at(-1)).toMatchObject({
      type: 'run.status',
      status: 'AWAITING_INPUT',
    });
    // Nothing answered yet: the history ends with the assistant's calls.
    expect(rt.transcript(conversationId).at(-1)!.role).toBe('assistant');

    const outcome = await rt.inputs.submit({
      runId,
      toolCallId: 'call_ask',
      body: VALID,
      identity: HUMAN,
    });
    expect(outcome).toEqual({ outcome: 'submitted', runStatus: 'QUEUED' });
    expect(inputRow().status).toBe('SUCCEEDED');
    expect(rt.events(runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'input.resolved',
          toolCallId: 'call_ask',
          outcome: 'submitted',
        }),
      ]),
    );

    await rt.drain();
    expect(status(runId)).toBe('SUCCEEDED');
    // ONE tool message answers both calls, in call order.
    const [results] = toolMessages(conversationId);
    expect(results.map((r) => r.toolCallId)).toEqual(['call_r', 'call_ask']);
    expect(results[1].isError).toBe(false);
    expect(results[1].output).toMatchObject({
      ok: true,
      kind: 'navigate',
      mutated: false,
      data: {
        outcome: 'submitted',
        providedBy: 'user',
        answer: {
          // Normalized: text trimmed, a number sent as text parsed.
          values: { manufacturer: 'Dell', notes: 'for the new hires' },
          groups: { models: [{ name: 'Latitude 5450', count: 4 }] },
        },
        labels: { 'values.manufacturer': 'Dell' },
      },
    });
    // The user's own answer is not other-authored content: never wrapped as untrusted.
    expect(JSON.stringify(results[1].output)).not.toContain(
      '<untrusted_content>',
    );
  });

  it('projects the form into the transcript with its outcome and the answer', async () => {
    const { runId, conversationId } = await paused();
    const project = () =>
      projectTranscript({
        conversationId,
        rows: rt.messages(conversationId) as never,
        invocations: rt.prisma.tables.aiToolInvocation.rows as never,
        classOf: (name) => rt.registry.get(name)?.descriptor.class,
      });
    const waiting = project()
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'input');
    expect(waiting).toMatchObject({
      type: 'input',
      request: { toolCallId: 'call_ask', form: FAKE_FORM },
      outcome: null,
    });
    expect(AiMessagePartSchema.safeParse(waiting).success).toBe(true);

    await rt.inputs.submit({
      runId,
      toolCallId: 'call_ask',
      body: VALID,
      identity: HUMAN,
    });
    const answered = project()
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'input');
    expect(answered).toMatchObject({
      outcome: 'submitted',
      answer: { values: { manufacturer: 'Dell' } },
    });
  });

  it('refuses an answer that does not match the STORED form and keeps waiting', async () => {
    const { runId } = await paused();
    const refused = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: {
          action: 'submit',
          values: { manufacturer: 'Acme', password: 'x' },
          groups: { models: [] },
        },
        identity: HUMAN,
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('INVALID_INPUT');
    expect(refused.body.issues).toEqual(
      expect.arrayContaining([
        { path: 'values.password', message: 'Unknown field' },
        {
          path: 'values.manufacturer',
          message: 'Not one of the offered options',
        },
        { path: 'groups.models', message: 'Between 1 and 5 rows' },
      ]),
    );
    expect(status(runId)).toBe('AWAITING_INPUT');
    expect(inputRow().status).toBe('AWAITING_INPUT');
  });

  it.each([
    ['skip', 'skipped', 'skipped this form'],
    ['cancel', 'declined', 'declined to provide'],
  ] as const)(
    '%s answers the model that the user %s, and the run continues',
    async (action, outcome, note) => {
      const { runId, conversationId } = await paused();
      const result = await rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: { action },
        identity: HUMAN,
      });
      expect(result.outcome).toBe(outcome);
      expect(inputRow().status).toBe('REJECTED');
      await rt.drain();
      expect(status(runId)).toBe('SUCCEEDED');
      const [results] = toolMessages(conversationId);
      expect(results[1].output.data).toMatchObject({
        outcome,
        providedBy: 'user',
      });
      expect(results[1].output.data.note).toContain(note);
      expect(results[1].output.data.answer).toBeUndefined();
    },
  );

  it('answers once: a second answer is refused and resumes nothing', async () => {
    const { runId } = await paused();
    const submit = () =>
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: VALID,
        identity: HUMAN,
      });
    await submit();
    const again = await refusedWith(submit());
    expect(again).toMatchObject({
      status: 409,
      body: { code: 'RUN_NOT_AWAITING_INPUT' },
    });
    expect(rt.queue.jobs.filter((j) => j.name === 'resume')).toHaveLength(1);
  });

  it('only the run owner, from a human session, can answer', async () => {
    const { runId } = await paused();
    const other = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: VALID,
        identity: { kind: 'human', userId: OTHER_USER_ID, sessionEpoch: 1 },
      }),
    );
    expect(other).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    const service = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: VALID,
        identity: SERVICE,
      }),
    );
    expect(service).toMatchObject({ status: 403 });
    const unknown = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_r',
        body: VALID,
        identity: HUMAN,
      }),
    );
    expect(unknown).toMatchObject({ status: 404 });
    expect(status(runId)).toBe('AWAITING_INPUT');
  });

  it('is not an approval: the decision endpoint cannot resolve it', async () => {
    const { runId } = await paused();
    const decided = await refusedWith(
      rt.approvals.decide({
        runId,
        toolCallId: 'call_ask',
        decision: 'approve',
        identity: HUMAN,
      }),
    );
    expect(decided).toMatchObject({
      status: 409,
      body: { code: 'RUN_NOT_AWAITING_APPROVAL' },
    });
    expect(rt.tools.approved).toHaveLength(0);
    expect(inputRow().status).toBe('AWAITING_INPUT');
  });

  it('refuses an answer while the assistant is turned off (the kill switch)', async () => {
    const { runId } = await paused();
    rt.settings.config = null;
    const refused = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: VALID,
        identity: HUMAN,
      }),
    );
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'AI_DISABLED' },
    });
    // The sweeper then cancels the waiting run, answering every call.
    const later = new Date(Date.now() + 2 * 60 * 1000);
    const swept = await rt.sweeper.sweep(later);
    expect(swept.cancelled).toBe(1);
    expect(status(runId)).toBe('CANCELLED');
    expect(inputRow().status).toBe('CANCELLED');
  });
});

describe('request_input: limits of the pause', () => {
  it('is refused in a step that also changes data; the write still waits for its card', async () => {
    rt.model.push({
      toolCalls: [
        { toolCallId: 'call_ask', toolName: ASK, input: {} },
        { toolCallId: 'call_w', toolName: WRITE, input: { id: 'a1' } },
      ],
    });
    const { runId } = await chat();
    await rt.drain();
    expect(status(runId)).toBe('AWAITING_APPROVAL');
    expect(
      rt.prisma.tables.aiToolInvocation.rows.map((r) => r.toolName),
    ).toEqual([WRITE]);
    await rt.approvals.decide({
      runId,
      toolCallId: 'call_w',
      decision: 'reject',
      identity: HUMAN,
    });
    rt.model.push({ text: 'ok' });
    await rt.drain();
    const conversationId = rt.run(runId).conversationId as string;
    const [results] = toolMessages(conversationId);
    expect(results[0]).toMatchObject({ toolCallId: 'call_ask', isError: true });
    expect(results[0].output.error.message).toContain('step of its own');
  });

  it('asks with one form per step', async () => {
    rt.model.push(
      {
        toolCalls: [
          { toolCallId: 'a1', toolName: ASK, input: {} },
          { toolCallId: 'a2', toolName: ASK, input: {} },
        ],
      },
      { text: 'ok' },
    );
    const { runId, conversationId } = await chat();
    await rt.drain();
    expect(status(runId)).toBe('AWAITING_INPUT');
    expect(
      rt.prisma.tables.aiToolInvocation.rows.filter((r) => r.toolName === ASK),
    ).toHaveLength(1);
    await rt.inputs.submit({
      runId,
      toolCallId: 'a1',
      body: { action: 'skip' },
      identity: HUMAN,
    });
    await rt.drain();
    const [results] = toolMessages(conversationId);
    expect(results[1]).toMatchObject({ toolCallId: 'a2', isError: true });
    expect(results[1].output.error.message).toContain('one form at a time');
  });

  it('a refused form (a secret) is answered as an error and the run goes on', async () => {
    rt.model.push(
      {
        toolCalls: [
          { toolCallId: 'call_ask', toolName: ASK, input: { secret: true } },
        ],
      },
      { text: 'I cannot ask for that.' },
    );
    const { runId, conversationId } = await chat();
    await rt.drain();
    expect(status(runId)).toBe('SUCCEEDED');
    expect(rt.prisma.tables.aiToolInvocation.rows).toHaveLength(0);
    const [results] = toolMessages(conversationId);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0].output.error.code).toBe('INVALID_INPUT');
  });

  it('an unanswered form expires like an approval: the run ends EXPIRED, every call answered', async () => {
    const { runId, conversationId } = await paused();
    const later = new Date(Date.now() + 31 * 60 * 1000);
    const swept = await rt.sweeper.sweep(later);
    expect(swept.expired).toBe(1);
    expect(status(runId)).toBe('EXPIRED');
    expect(rt.run(runId).finishReason).toBe('input_expired');
    expect(inputRow().status).toBe('EXPIRED');
    const [results] = toolMessages(conversationId);
    expect(results[1]).toMatchObject({ toolCallId: 'call_ask', isError: true });
    expect(results[1].output.error.code).toBe('EXPIRED');
    expect(
      rt.events(runId).find((e) => e.type === 'input.resolved'),
    ).toMatchObject({ outcome: 'expired' });
  });

  it('a late answer after the expiry ends the run EXPIRED', async () => {
    const { runId } = await paused();
    rt.prisma.tables.aiToolInvocation.rows.find(
      (r) => r.toolName === ASK,
    )!.expiresAt = new Date(Date.now() - 1000);
    const refused = await refusedWith(
      rt.inputs.submit({
        runId,
        toolCallId: 'call_ask',
        body: VALID,
        identity: HUMAN,
      }),
    );
    expect(refused).toMatchObject({ status: 409, body: { code: 'EXPIRED' } });
    expect(status(runId)).toBe('EXPIRED');
    expect(inputRow().status).toBe('EXPIRED');
  });

  it('cancelling the run cancels the form and answers every call', async () => {
    const { runId, conversationId } = await paused();
    await rt.orchestrator.cancel(runId, HUMAN);
    expect(status(runId)).toBe('CANCELLED');
    expect(inputRow().status).toBe('CANCELLED');
    const [results] = toolMessages(conversationId);
    expect(results[1]).toMatchObject({ toolCallId: 'call_ask', isError: true });
    expect(
      rt.events(runId).find((e) => e.type === 'input.resolved'),
    ).toMatchObject({ outcome: 'cancelled' });
  });

  it('counts as the conversation’s active run: a new message is refused while it waits', async () => {
    const { conversationId } = await paused();
    await expect(
      rt.orchestrator.submit({
        identity: HUMAN,
        channel: 'CHAT',
        text: 'another question',
        conversationId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
