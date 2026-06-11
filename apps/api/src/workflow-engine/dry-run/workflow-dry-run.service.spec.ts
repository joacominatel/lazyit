jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkflowDryRunService } from './workflow-dry-run.service';
import type { WorkflowDryRunInput } from './workflow-dry-run.dto';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * C4 — DRY-RUN resolver. A pure payload-resolution preview: it walks the latest version's DAG, resolves
 * each step's data mapping against a REAL sample grant, classifies the success/failure edge with the
 * same helpers the run timeline uses, and renders the would-be requests — making NO external call and
 * writing NO ledger rows, with secret-backed values shown as `‹secret:label›` placeholders (INV-6).
 */

const APP = 'app_cuid_1';
const REQUEST_ID = 'req-c4-9';
// Step `connectionId`s are validated as cuids by WorkflowStepsSchema, so use real cuid literals.
const CONN1 = 'clae1qux10000gv8l9p9q8z1a';
const CONN2 = 'cjld2cjxh0000qzrmn831i7rn';

// A 2-step happy path: REST create → WEBHOOK_OUT notify → END_SUCCESS.
const TWO_STEP = [
  {
    kind: 'REST',
    key: 'create',
    connectionId: CONN1,
    method: 'POST',
    path: '/v3/user/{{ grantee.id }}',
    dataMapping: { emailAddress: '{{ grantee.email }}' },
  },
  {
    kind: 'WEBHOOK_OUT',
    key: 'notify',
    connectionId: CONN2,
    dataMapping: { event: 'created', who: '{{ grantee.email }}' },
  },
];

const CONN_ROWS = [
  {
    id: CONN1,
    secretId: 'sec1',
    config: {
      kind: 'REST',
      baseUrl: 'https://api.example.com',
      authScheme: 'BEARER',
    },
  },
  {
    id: CONN2,
    secretId: 'sec2',
    config: {
      kind: 'WEBHOOK_OUT',
      url: 'https://hooks.example.com/x',
      signatureHeader: 'X-Signature',
    },
  },
];

const SECRET_ROWS = [
  { id: 'sec1', label: 'Jira API token' },
  { id: 'sec2', label: 'Webhook signing key' },
];

function makePrisma(opts: {
  steps?: unknown;
  workflow?: unknown;
  connRows?: unknown[];
  secretRows?: unknown[];
  grant?: unknown;
}) {
  const versions =
    opts.steps !== undefined
      ? [{ id: 7, version: 3, steps: opts.steps }]
      : [{ id: 7, version: 3, steps: TWO_STEP }];
  const workflow =
    opts.workflow !== undefined
      ? opts.workflow
      : {
          id: 'wf1',
          applicationId: APP,
          trigger: 'ACCESS_GRANTED',
          application: { id: APP, name: 'Jira' },
          versions,
        };

  const grant =
    opts.grant !== undefined
      ? opts.grant
      : {
          id: 'grant1',
          applicationId: APP,
          accessLevel: 'developer',
          grantedAt: new Date('2026-06-08T00:00:00.000Z'),
          expiresAt: null,
          user: {
            id: 'usr_1',
            email: 'ada@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            legajo: null,
            username: null,
            managerName: null,
            manager: null,
          },
        };

  const applicationWorkflow = {
    findFirst: jest.fn().mockResolvedValue(workflow),
  };
  const accessGrant = { findFirst: jest.fn().mockResolvedValue(grant) };
  const workflowConnection = {
    findMany: jest.fn().mockResolvedValue(opts.connRows ?? CONN_ROWS),
  };
  const workflowSecret = {
    findMany: jest.fn().mockResolvedValue(opts.secretRows ?? SECRET_ROWS),
  };
  // Ledger writers — the dry-run must NEVER call these.
  const workflowRun = {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const workflowStepRun = { create: jest.fn() };
  const manualTask = { create: jest.fn() };

  const prisma = {
    applicationWorkflow,
    accessGrant,
    workflowConnection,
    workflowSecret,
    workflowRun,
    workflowStepRun,
    manualTask,
  } as unknown as PrismaService;

  return {
    service: new WorkflowDryRunService(prisma),
    applicationWorkflow,
    accessGrant,
    workflowRun,
    workflowStepRun,
    manualTask,
  };
}

const byId: WorkflowDryRunInput = {
  workflowId: 'wf1',
  sampleAccessGrantId: 'grant1',
};

describe('WorkflowDryRunService.dryRun — C4', () => {
  it('resolves the payloads + the DAG traversal (happy path) and writes NO rows', async () => {
    const h = makePrisma({});
    const result = await h.service.dryRun(byId, REQUEST_ID);

    expect(result.dryRun).toBe(true);
    expect(result.requestId).toBe(REQUEST_ID);
    expect(result.workflowVersionId).toBe(7);
    expect(result.version).toBe(3);
    expect(result.endState).toBe('END_SUCCESS');
    expect(result.wouldPause).toBe(false);
    expect(result.steps).toHaveLength(2);

    const [create, notify] = result.steps;
    // Step 0 — REST: resolved URL (path interpolated + encoded), resolved body, NEXT edge.
    expect(create.kind).toBe('REST');
    expect(create.status).toBe('SUCCEEDED');
    expect(create.simulated).toBe(false);
    expect(create.request?.method).toBe('POST');
    expect(create.request?.url).toBe('https://api.example.com/v3/user/usr_1');
    expect(create.request?.body).toEqual({ emailAddress: 'ada@example.com' });
    expect(create.mappedFields).toEqual(['emailAddress']);
    expect(create.transitionTaken).toEqual({
      outcome: 'SUCCESS',
      edge: 'NEXT',
      targetStepKey: 'notify',
    });

    // Step 1 — WEBHOOK_OUT: resolved body, END edge, signed.
    expect(notify.kind).toBe('WEBHOOK_OUT');
    expect(notify.request?.url).toBe('https://hooks.example.com/x');
    expect(notify.request?.body).toEqual({
      event: 'created',
      who: 'ada@example.com',
    });
    expect(notify.request?.signed).toBe(true);
    expect(notify.transitionTaken).toEqual({ outcome: 'SUCCESS', edge: 'END' });

    // INV-5: a pure resolver — no WorkflowRun / WorkflowStepRun / ManualTask row written.
    expect(h.workflowRun.create).not.toHaveBeenCalled();
    expect(h.workflowStepRun.create).not.toHaveBeenCalled();
    expect(h.manualTask.create).not.toHaveBeenCalled();
  });

  it('redacts secret-backed header values as `‹secret:label›` placeholders (INV-6)', async () => {
    const h = makePrisma({});
    const result = await h.service.dryRun(byId, REQUEST_ID);

    const create = result.steps[0];
    const notify = result.steps[1];
    expect(create.request?.headers['authorization']).toBe(
      'Bearer ‹secret:Jira API token›',
    );
    expect(notify.request?.headers['X-Signature']).toBe(
      'sha256=‹secret:Webhook signing key›',
    );
    // The label is the redacted descriptor — never a real credential. Nothing decryptable leaks.
    expect(JSON.stringify(result)).not.toContain('decrypt');
  });

  it('previews a SIMULATED failure edge (STOP) without provoking a real error', async () => {
    const h = makePrisma({});
    const result = await h.service.dryRun(
      { ...byId, simulate: { stepKey: 'create', outcome: 'FAILURE' } },
      REQUEST_ID,
    );

    expect(result.endState).toBe('STOP_FAIL');
    expect(result.steps).toHaveLength(1);
    const create = result.steps[0];
    expect(create.status).toBe('FAILED');
    expect(create.simulated).toBe(true);
    expect(create.transitionTaken).toEqual({
      outcome: 'FAILURE',
      edge: 'STOP',
    });
    // Still no rows / no calls.
    expect(h.workflowStepRun.create).not.toHaveBeenCalled();
  });

  it('previews a SIMULATED failure that ESCALATES to a manual task', async () => {
    const steps = [
      {
        kind: 'REST',
        key: 'create',
        connectionId: CONN1,
        method: 'POST',
        path: '/v3/user',
        dataMapping: { email: '{{ grantee.email }}' },
        onFailure: 'ESCALATE_TO_MANUAL',
      },
    ];
    const h = makePrisma({
      steps,
      connRows: [CONN_ROWS[0]],
      secretRows: [SECRET_ROWS[0]],
    });
    const result = await h.service.dryRun(
      { ...byId, simulate: { stepKey: 'create', outcome: 'FAILURE' } },
      REQUEST_ID,
    );

    expect(result.endState).toBe('ESCALATE_TO_MANUAL');
    expect(result.steps[0].transitionTaken).toEqual({
      outcome: 'FAILURE',
      edge: 'ESCALATE',
    });
  });

  it('marks a MANUAL step as a PAUSE and continues the happy-path traversal (wouldPause)', async () => {
    const steps = [
      {
        kind: 'MANUAL',
        key: 'approve',
        prompt: 'Approve access for {{ grantee.email }}?',
        inputFields: [{ name: 'decision', label: 'Decision', type: 'boolean' }],
      },
      {
        kind: 'REST',
        key: 'create',
        connectionId: CONN1,
        method: 'POST',
        path: '/v3/user',
        dataMapping: { email: '{{ grantee.email }}' },
      },
    ];
    const h = makePrisma({
      steps,
      connRows: [CONN_ROWS[0]],
      secretRows: [SECRET_ROWS[0]],
    });
    const result = await h.service.dryRun(byId, REQUEST_ID);

    expect(result.wouldPause).toBe(true);
    expect(result.endState).toBe('END_SUCCESS');
    expect(result.steps).toHaveLength(2);
    const approve = result.steps[0];
    expect(approve.kind).toBe('MANUAL');
    expect(approve.status).toBe('AWAITING_INPUT');
    expect(approve.manual?.prompt).toBe('Approve access for ada@example.com?');
    expect(approve.transitionTaken).toEqual({
      outcome: 'PAUSE',
      edge: 'PAUSE',
    });
    expect(result.steps[1].kind).toBe('REST');
  });

  it('resolves the workflow by applicationId + trigger', async () => {
    const h = makePrisma({});
    const result = await h.service.dryRun(
      {
        applicationId: APP,
        trigger: 'ACCESS_GRANTED',
        sampleAccessGrantId: 'grant1',
      },
      REQUEST_ID,
    );
    expect(result.endState).toBe('END_SUCCESS');
    const calls = h.applicationWorkflow.findFirst.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    const where = calls[0][0].where;
    expect(where).toMatchObject({
      applicationId: APP,
      trigger: 'ACCESS_GRANTED',
    });
  });

  it('warns (not throws) when a step references a missing/deleted connection', async () => {
    const h = makePrisma({ connRows: [] });
    const result = await h.service.dryRun(byId, REQUEST_ID);
    expect(result.steps[0].request).toBeNull();
    expect(result.steps[0].warnings[0]).toMatch(/missing, deleted/i);
  });

  it('404s when no workflow resolves', async () => {
    const h = makePrisma({ workflow: null });
    await expect(h.service.dryRun(byId, REQUEST_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('400s when the sample grant belongs to a different application', async () => {
    const h = makePrisma({
      grant: {
        id: 'grant1',
        applicationId: 'other_app',
        accessLevel: null,
        grantedAt: new Date('2026-06-08T00:00:00.000Z'),
        expiresAt: null,
        user: { id: 'u', email: 'a@b.c', firstName: 'A', lastName: 'B' },
      },
    });
    await expect(h.service.dryRun(byId, REQUEST_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s when simulate.stepKey is not a step in the version', async () => {
    const h = makePrisma({});
    await expect(
      h.service.dryRun(
        { ...byId, simulate: { stepKey: 'nope', outcome: 'FAILURE' } },
        REQUEST_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
