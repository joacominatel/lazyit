import { ManualStepHandler } from './manual.handler';
import {
  freezeMappingContext,
  type StepContext,
  type WorkflowMappingContext,
} from './step-handler';
import type { ManualConnectionConfig, ManualStep } from '@lazyit/shared';

function makeCtx(
  overrides: Partial<WorkflowMappingContext> = {},
): Readonly<WorkflowMappingContext> {
  return freezeMappingContext({
    event: 'ACCESS_GRANTED',
    grantee: {
      id: 'usr_1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      legajo: null,
      username: null,
      manager: { name: null, email: null, isOffboarded: false },
    },
    application: { id: 'app_1', name: 'Jira' },
    grant: {
      id: 'grant_1',
      accessLevel: 'developer',
      grantedAt: '2026-06-08T00:00:00.000Z',
      expiresAt: null,
    },
    steps: {},
    ...overrides,
  });
}

const STEP: ManualStep = {
  kind: 'MANUAL',
  key: 'pick-team',
  prompt: 'Create a Jira account for {{ grantee.email }} and pick a team',
  inputFields: [
    {
      name: 'team',
      label: 'Team',
      type: 'select',
      required: true,
      options: ['platform', 'payments'],
      suggestions: ['platform'],
    },
  ],
  cohort: 'it-ops',
};

function ctxFor(
  step: ManualStep,
  data: Readonly<WorkflowMappingContext> = makeCtx(),
): StepContext<ManualConnectionConfig, ManualStep> {
  return {
    connection: { kind: 'MANUAL' },
    step,
    revealSecret: () => Promise.resolve(null),
    data,
    meta: { runId: 'run_1', stepKey: step.key, stepIndex: 0, attempt: 1 },
  };
}

describe('ManualStepHandler.execute', () => {
  it('returns AWAITING_INPUT with a manual-task spec (no external call)', async () => {
    const handler = new ManualStepHandler();
    const result = await handler.execute(ctxFor(STEP));

    expect(result.status).toBe('AWAITING_INPUT');
    expect(result.manualTask).toBeDefined();
    expect(result.manualTask?.stepKey).toBe('pick-team');
    expect(result.manualTask?.cohort).toBe('it-ops');
    // The typed input schema + STATIC suggestions pass straight through from the step config.
    expect(result.manualTask?.inputFields).toEqual(STEP.inputFields);
    expect(result.manualTask?.inputFields[0].suggestions).toEqual(['platform']);
  });

  it('renders the prompt against ctx (text mode — no encoding)', async () => {
    const handler = new ManualStepHandler();
    const result = await handler.execute(ctxFor(STEP));
    expect(result.manualTask?.prompt).toBe(
      'Create a Jira account for ada@example.com and pick a team',
    );
  });

  it('never re-interprets a ctx value as a template inside the prompt (no SSTI)', async () => {
    const handler = new ManualStepHandler();
    const data = makeCtx({
      grantee: {
        id: 'usr_1',
        email: '{{ application.name }}',
        firstName: 'A',
        lastName: 'B',
        legajo: null,
        username: null,
        manager: { name: null, email: null, isOffboarded: false },
      },
    });
    const result = await handler.execute(ctxFor(STEP, data));
    expect(result.manualTask?.prompt).toContain('{{ application.name }}');
    expect(result.manualTask?.prompt).not.toContain('Jira and pick');
  });
});
