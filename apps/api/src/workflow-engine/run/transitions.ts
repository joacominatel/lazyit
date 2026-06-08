import {
  WORKFLOW_COMPENSATE,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  type WorkflowStep,
} from '@lazyit/shared';
import type { TransitionTaken } from './workflow-run.types';

/**
 * Classify the EFFECTIVE edge a step took into the closed `TransitionTaken` vocabulary the run-detail
 * UI renders (ADR-0054 §8 / frontend C2). Pure — operates only on the resolved targets from the shared
 * `resolveStepTransitions` (the single source of truth; this never re-derives precedence). The closed
 * three-value success set (NEXT | GOTO | END) and four-value failure set (CONTINUE | ESCALATE |
 * COMPENSATE | STOP, plus GOTO to a handler step) ARE the entire vocabulary — no business-condition
 * edges (the §8 guardrail at the contract boundary).
 */

/** Classify a SUCCEEDED step's `onSuccess` target. */
export function classifySuccessEdge(
  steps: readonly WorkflowStep[],
  index: number,
  onSuccess: string,
): TransitionTaken {
  if (onSuccess === WORKFLOW_END_SUCCESS) {
    return { outcome: 'SUCCESS', edge: 'END' };
  }
  const next = steps[index + 1];
  if (next && next.key === onSuccess) {
    return { outcome: 'SUCCESS', edge: 'NEXT', targetStepKey: onSuccess };
  }
  return { outcome: 'SUCCESS', edge: 'GOTO', targetStepKey: onSuccess };
}

/**
 * Classify a FAILED step's `onFailure` target. `onSuccess` is supplied so a legacy `onError:continue`
 * (which maps `onFailure` to the success edge) is reported as CONTINUE rather than a bare GOTO.
 */
export function classifyFailureEdge(
  onFailure: string,
  onSuccess: string,
): TransitionTaken {
  if (onFailure === WORKFLOW_ESCALATE_TO_MANUAL) {
    return { outcome: 'FAILURE', edge: 'ESCALATE' };
  }
  if (onFailure === WORKFLOW_COMPENSATE) {
    return { outcome: 'FAILURE', edge: 'COMPENSATE' };
  }
  if (onFailure === WORKFLOW_STOP_FAIL) {
    return { outcome: 'FAILURE', edge: 'STOP' };
  }
  // A step-key failure target. If it equals the success edge it is a "continue / fall-through".
  if (onFailure === onSuccess) {
    return { outcome: 'FAILURE', edge: 'CONTINUE', targetStepKey: onFailure };
  }
  return { outcome: 'FAILURE', edge: 'GOTO', targetStepKey: onFailure };
}

/** True when a resolved transition target is a terminal token (not a step key). */
export function isTerminalTarget(target: string): boolean {
  return (
    target === WORKFLOW_END_SUCCESS ||
    target === WORKFLOW_ESCALATE_TO_MANUAL ||
    target === WORKFLOW_COMPENSATE ||
    target === WORKFLOW_STOP_FAIL
  );
}
