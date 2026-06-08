import { BadRequestException } from '@nestjs/common';
import { WorkflowStepsSchema } from '@lazyit/shared';
import {
  assertAllStepsReachable,
  stepsNeedingConnection,
} from './workflow-graph.validation';

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
