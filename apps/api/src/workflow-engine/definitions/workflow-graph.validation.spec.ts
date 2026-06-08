import { BadRequestException } from '@nestjs/common';
import { WorkflowStepsSchema } from '@lazyit/shared';
import {
  assertAllStepsReachable,
  assertNoManualEscalationFailureEdge,
  stepsNeedingConnection,
} from './workflow-graph.validation';

const manual = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'MANUAL',
  key,
  prompt: 'Pick a team',
  inputFields: [{ name: 'team', label: 'Team', type: 'text' }],
  ...extra,
});

const CONN = 'cjld2cjxh0000qzrmn831i7rn';
const rest = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'REST',
  key,
  connectionId: CONN,
  method: 'POST',
  path: `/${key}`,
  ...extra,
});

describe('assertAllStepsReachable', () => {
  it('passes a linear (degenerate DAG) graph', () => {
    const steps = WorkflowStepsSchema.parse([rest('s1'), rest('s2')]);
    expect(() => assertAllStepsReachable(steps)).not.toThrow();
  });

  it('passes when an error-handler step is reachable only via an onFailure edge', () => {
    const steps = WorkflowStepsSchema.parse([
      rest('s1', { onFailure: 'alert' }),
      rest('alert', { onSuccess: 'END_SUCCESS', onFailure: 'STOP_FAIL' }),
    ]);
    expect(() => assertAllStepsReachable(steps)).not.toThrow();
  });

  it('throws a field-addressable error listing an unreachable (orphan) step', () => {
    // s1 → END on success, STOP on failure; "orphan" is never targeted by any edge.
    const steps = WorkflowStepsSchema.parse([
      rest('s1', { onSuccess: 'END_SUCCESS', onFailure: 'STOP_FAIL' }),
      rest('orphan', { onSuccess: 'END_SUCCESS', onFailure: 'STOP_FAIL' }),
    ]);
    try {
      assertAllStepsReachable(steps);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        unreachableSteps: { key: string }[];
      };
      expect(body.unreachableSteps.map((u) => u.key)).toEqual(['orphan']);
    }
  });
});

describe('assertNoManualEscalationFailureEdge (CCOR-6)', () => {
  it('rejects a MANUAL step whose onFailure is ESCALATE_TO_MANUAL (field-addressable)', () => {
    const steps = WorkflowStepsSchema.parse([
      manual('m1', { onFailure: 'ESCALATE_TO_MANUAL' }),
      rest('s2'),
    ]);
    try {
      assertNoManualEscalationFailureEdge(steps);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        manualEscalationSteps: { key: string }[];
      };
      expect(body.manualEscalationSteps.map((s) => s.key)).toEqual(['m1']);
    }
  });

  it('is enforced through assertAllStepsReachable (the version-author gate)', () => {
    const steps = WorkflowStepsSchema.parse([
      manual('m1', { onFailure: 'ESCALATE_TO_MANUAL' }),
    ]);
    expect(() => assertAllStepsReachable(steps)).toThrow(BadRequestException);
  });

  it('still allows a NON-manual step to escalate its failure to manual', () => {
    const steps = WorkflowStepsSchema.parse([
      rest('s1', { onFailure: 'ESCALATE_TO_MANUAL' }),
      rest('handler'),
    ]);
    expect(() => assertNoManualEscalationFailureEdge(steps)).not.toThrow();
  });

  it('allows a MANUAL step with a default (STOP_FAIL) failure edge', () => {
    const steps = WorkflowStepsSchema.parse([manual('m1'), rest('s2')]);
    expect(() => assertNoManualEscalationFailureEdge(steps)).not.toThrow();
  });
});

describe('stepsNeedingConnection', () => {
  it('returns REST/WEBHOOK steps with their connectionId + index, skipping MANUAL', () => {
    const steps = WorkflowStepsSchema.parse([
      rest('s1'),
      {
        kind: 'MANUAL',
        key: 'm1',
        prompt: 'p',
        inputFields: [{ name: 'x', label: 'X', type: 'text' }],
      },
    ]);
    const refs = stepsNeedingConnection(steps);
    expect(refs).toEqual([{ index: 0, connectionId: CONN, kind: 'REST' }]);
  });
});
