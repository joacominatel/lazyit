/* eslint-disable @typescript-eslint/no-unsafe-assignment -- assertions read the loosely-typed rows and provider messages of the in-memory test database; intentional for this spec file only. */
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
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import type { LocalCredentialService } from '../../auth/local/local-credential.service';
import { PasswordStepUpVerifier } from '../../auth/local/password-step-up.verifier';
import {
  buildRuntime,
  HUMAN,
  OTHER_USER_ID,
  SERVICE,
  TOOLS,
  type Runtime,
} from './runtime.harness-spec';

/**
 * The runtime side of an approval (tools §9 "Boundary"; security.md §6.2): who may decide, the password
 * step-up verified with the local-auth verifier and rate-limited, then core's `approve(…, { stepUpVerified })`.
 */

const ELEVATED = TOOLS.elevated.descriptor.name;
const WRITE = TOOLS.write.descriptor.name;
const PASSWORD = 'correct horse';

let rt: Runtime;
let runId: string;
const savedMode = process.env.AUTH_MODE;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(async () => {
  process.env.AUTH_MODE = 'local';
  rt = buildRuntime();
  rt.model.push(
    {
      toolCalls: [
        { toolCallId: 'grant', toolName: ELEVATED, input: { userId: 'u2' } },
      ],
    },
    { text: 'Access granted.' },
  );
  ({ runId } = await rt.orchestrator.submit({
    identity: HUMAN,
    channel: 'CHAT',
    text: 'Grant it',
  }));
  await rt.drain();
});

afterAll(() => {
  process.env.AUTH_MODE = savedMode;
});

function decide(password?: string, identity: DelegatedIdentity = HUMAN) {
  return rt.approvals.decide({
    runId,
    toolCallId: 'grant',
    decision: 'approve',
    identity,
    ...(password !== undefined ? { password } : {}),
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as HttpException;
    return {
      status: e.getStatus(),
      body: e.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('expected a refusal');
}

function pendingStatus() {
  return rt.prisma.tables.aiToolInvocation.rows[0].status as string;
}

describe('password step-up', () => {
  it('announces the elevated card with step-up required', () => {
    expect(
      rt.events(runId).find((e) => e.type === 'tool.approval_required'),
    ).toMatchObject({
      toolCallId: 'grant',
      elevated: true,
      stepUpRequired: true,
    });
  });

  it('refuses an approval without the password, leaving the action pending', async () => {
    expect(await refusal(decide())).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    expect(rt.tools.approved).toHaveLength(0);
    expect(pendingStatus()).toBe('AWAITING_APPROVAL');
  });

  it('refuses a wrong password without reaching core', async () => {
    expect(await refusal(decide('wrong'))).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_FAILED' },
    });
    expect(rt.tools.approved).toHaveLength(0);
    expect(pendingStatus()).toBe('AWAITING_APPROVAL');
    expect(rt.run(runId).status).toBe('AWAITING_APPROVAL');
  });

  it('rate-limits repeated wrong passwords, even a correct one while locked', async () => {
    let clock = Date.now();
    rt.stepUp.now = () => clock;
    for (let i = 0; i < 6; i += 1) {
      expect((await refusal(decide('wrong'))).body.code).toBe('STEP_UP_FAILED');
    }
    const locked = await refusal(decide(PASSWORD));
    expect(locked).toMatchObject({
      status: 429,
      body: { code: 'STEP_UP_RATE_LIMITED', retryAfterSec: 1 },
    });
    expect(rt.tools.approved).toHaveLength(0);

    // The backoff grows with each failure past the threshold.
    clock += 1_500;
    expect((await refusal(decide('wrong'))).body.code).toBe('STEP_UP_FAILED');
    expect((await refusal(decide(PASSWORD))).body).toMatchObject({
      code: 'STEP_UP_RATE_LIMITED',
      retryAfterSec: 2,
    });

    clock += 2_500;
    const ok = await decide(PASSWORD);
    expect(ok.action.status).toBe('SUCCEEDED');
  });

  it('approves with stepUpVerified after the correct password, and resumes', async () => {
    const outcome = await decide(PASSWORD);
    expect(rt.tools.approved).toEqual([
      {
        id: rt.prisma.tables.aiToolInvocation.rows[0].id,
        stepUpVerified: true,
      },
    ]);
    expect(outcome.runStatus).toBe('QUEUED');
    await rt.drain();
    expect(rt.run(runId).status).toBe('SUCCEEDED');
  });

  it('is unavailable outside local auth (fail closed)', async () => {
    process.env.AUTH_MODE = 'oidc';
    expect(await refusal(decide(PASSWORD))).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_UNAVAILABLE' },
    });
    expect(rt.tools.approved).toHaveLength(0);
  });

  it('refuses a password step-up from a revoked session', async () => {
    rt.loader.user.sessionEpoch += 1;
    expect((await refusal(decide(PASSWORD))).status).toBe(403);
    expect(rt.tools.approved).toHaveLength(0);
  });
});

describe('who decides', () => {
  it('refuses to approve while AI is turned off; the action stays pending', async () => {
    rt.settings.config = null;
    expect(await refusal(decide(PASSWORD))).toMatchObject({
      status: 409,
      body: { code: 'AI_DISABLED' },
    });
    expect(rt.tools.approved).toHaveLength(0);
    expect(pendingStatus()).toBe('AWAITING_APPROVAL');
  });

  it('refuses a decision on a run that is not waiting for one', async () => {
    await rt.orchestrator.cancel(runId, HUMAN);
    expect(await refusal(decide(PASSWORD))).toMatchObject({
      status: 409,
      body: { code: 'RUN_NOT_AWAITING_APPROVAL' },
    });
    expect(rt.tools.approved).toHaveLength(0);
  });

  it('only the run owner, from a human session', async () => {
    const other: DelegatedIdentity = {
      kind: 'human',
      userId: OTHER_USER_ID,
      sessionEpoch: 1,
    };
    expect((await refusal(decide(PASSWORD, other))).status).toBe(404);
    expect((await refusal(decide(PASSWORD, SERVICE))).status).toBe(403);
    expect(
      (
        await refusal(
          rt.approvals.decide({
            runId,
            toolCallId: 'nope',
            decision: 'approve',
            identity: HUMAN,
          }),
        )
      ).status,
    ).toBe(404);
    expect(rt.tools.approved).toHaveLength(0);
  });

  it('an ordinary write needs no password, and a sent one is ignored', async () => {
    const fresh = buildRuntime();
    fresh.model.push({
      toolCalls: [{ toolCallId: 'w', toolName: WRITE, input: { id: 'a1' } }],
    });
    const run = await fresh.orchestrator.submit({
      identity: HUMAN,
      channel: 'CHAT',
      text: 'x',
    });
    await fresh.drain();
    await fresh.approvals.decide({
      runId: run.runId,
      toolCallId: 'w',
      decision: 'approve',
      password: 'anything',
      identity: HUMAN,
    });
    expect(fresh.tools.approved).toEqual([
      expect.objectContaining({ stepUpVerified: false }),
    ]);
  });

  it('a decision after the approval window ends the run EXPIRED', async () => {
    const row = rt.prisma.tables.aiToolInvocation.rows[0];
    row.expiresAt = new Date(Date.now() - 1_000);
    expect((await refusal(decide(PASSWORD))).body.code).toBe('EXPIRED');
    expect(rt.run(runId).status).toBe('EXPIRED');
    expect(rt.events(runId).map((e) => e.type)).toContain(
      'tool.approval_resolved',
    );
  });
});

describe('PasswordStepUpVerifier under a burst', () => {
  it('lets one verification per user reach the KDF; concurrent attempts are refused', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = jest.fn(async () => {
      await gate;
      return { valid: false, needsRehash: false };
    });
    const verifier = new PasswordStepUpVerifier({
      verify,
    } as unknown as LocalCredentialService);
    const user = { id: 'u1', passwordHash: 'hash:x' } as never;

    const burst = Array.from({ length: 200 }, () =>
      verifier.verify(user, 'guess'),
    );
    release();
    const results = await Promise.all(burst);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => !r.ok && r.reason === 'invalid')).toHaveLength(
      1,
    );
    expect(results.filter((r) => !r.ok && r.reason === 'locked')).toHaveLength(
      199,
    );
  });

  it('counts an attempt before the KDF answers', async () => {
    const verify = jest.fn(() => new Promise<never>(() => undefined)); // the KDF never returns
    const verifier = new PasswordStepUpVerifier({
      verify,
    } as unknown as LocalCredentialService);
    const user = { id: 'u1', passwordHash: 'hash:x' } as never;
    void verifier.verify(user, 'guess');
    await Promise.resolve();
    expect(
      (
        verifier as unknown as { attempts: Map<string, { count: number }> }
      ).attempts.get('u1')?.count,
    ).toBe(1);
  });
});
