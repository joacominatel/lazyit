import { BadRequestException } from '@nestjs/common';
import {
  resolveStepTransitions,
  WORKFLOW_ESCALATE_TO_MANUAL,
  type WorkflowStep,
  type WorkflowSteps,
} from '@lazyit/shared';

/**
 * Graph validations a WorkflowVersion write must satisfy BEYOND the shared `WorkflowStepsSchema` (which
 * already enforces unique keys, no reserved-token collisions, valid edge targets, and acyclicity). Here
 * we add what needs whole-graph (or per-kind) reasoning the zod discriminated-union schema does not
 * cover:
 *
 *  - REACHABILITY: every step must be reachable from the entry node (`steps[0]`) over the EFFECTIVE
 *    edges (the shared `resolveStepTransitions` — never re-deriving precedence). An orphan step is a
 *    builder bug; we surface it as a field-addressable 400 the UI can attach to the box.
 *  - MANUAL FAILURE EDGE (CCOR-6): a MANUAL step's `onFailure` may NOT be `ESCALATE_TO_MANUAL`.
 *    Escalating a human-cancelled manual task to ANOTHER manual task is meaningless (and re-targets the
 *    same step, a cancel→escalate→cancel loop); at runtime that cursor reaches the walk's terminal
 *    handler and collapses to FAILED. Disallowing it at author-time is the clean prevention.
 *
 * Both run through {@link assertAllStepsReachable} (the single graph-validation entry the version-author
 * path already calls). Connection-reference validity (a REST/WEBHOOK step's `connectionId` must exist,
 * belong to the same application, and match the kind) needs the DB and lives in the service, not here.
 */

/**
 * The full author-time graph gate: reachability + the MANUAL failure-edge rule. (Named for its
 * historical first check; the version-author path calls this one function.)
 */
export function assertAllStepsReachable(steps: WorkflowSteps): void {
  assertNoManualEscalationFailureEdge(steps);
  assertEveryStepReachable(steps);
}

/**
 * CCOR-6 — reject a MANUAL step whose EFFECTIVE failure edge is `ESCALATE_TO_MANUAL`. Field-addressable
 * so the builder UI can attach the error to the offending step. Uses the shared `resolveStepTransitions`
 * (a MANUAL step has no legacy `onError`, so this is just its explicit `onFailure`, if any).
 */
export function assertNoManualEscalationFailureEdge(
  steps: WorkflowSteps,
): void {
  const offending = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step, index }) =>
        step.kind === 'MANUAL' &&
        resolveStepTransitions(steps, index).onFailure ===
          WORKFLOW_ESCALATE_TO_MANUAL,
    );
  if (offending.length > 0) {
    throw new BadRequestException({
      message: `A MANUAL step's failure edge may not be ESCALATE_TO_MANUAL: ${offending
        .map((o) => `"${o.step.key}"`)
        .join(', ')}`,
      manualEscalationSteps: offending.map((o) => ({
        index: o.index,
        key: o.step.key,
      })),
    });
  }
}

/** Throw a 400 listing any step not reachable from the entry node over the effective edges. */
export function assertEveryStepReachable(steps: WorkflowSteps): void {
  const indexByKey = new Map(steps.map((s, i) => [s.key, i]));
  const reachable = new Set<number>();
  const stack = [0];
  reachable.add(0);
  while (stack.length > 0) {
    const i = stack.pop();
    if (i === undefined) {
      break;
    }
    const { onSuccess, onFailure } = resolveStepTransitions(steps, i);
    for (const target of [onSuccess, onFailure]) {
      const j = indexByKey.get(target);
      if (j !== undefined && !reachable.has(j)) {
        reachable.add(j);
        stack.push(j);
      }
    }
  }
  const unreachable = steps
    .map((s, i) => ({ key: s.key, i }))
    .filter(({ i }) => !reachable.has(i));
  if (unreachable.length > 0) {
    throw new BadRequestException({
      message: `These steps are unreachable from the entry node: ${unreachable
        .map((u) => `"${u.key}"`)
        .join(', ')}`,
      unreachableSteps: unreachable.map((u) => ({ index: u.i, key: u.key })),
    });
  }
}

/** The step kinds that reference a `connectionId` (REST / WEBHOOK_OUT). */
export function stepsNeedingConnection(
  steps: readonly WorkflowStep[],
): { index: number; connectionId: string; kind: string }[] {
  const out: { index: number; connectionId: string; kind: string }[] = [];
  steps.forEach((step, index) => {
    if (step.kind === 'REST' || step.kind === 'WEBHOOK_OUT') {
      out.push({ index, connectionId: step.connectionId, kind: step.kind });
    }
  });
  return out;
}
