import type { GrantProvisioning, WorkflowRunStatus } from '@lazyit/shared';

/**
 * The coarse, requester-facing provisioning status of a grant (#1700, CEO decision Q2 on #1344),
 * derived on read from the LATEST `ACCESS_GRANTED` workflow run linked to the grant by
 * `accessGrantId`. No column, no migration. The mapping is documented in
 * docs/02-domain/entities/access-grant.md ("Provisioning status"):
 *
 *   no ACCESS_GRANTED run           → NONE           (no automation for this grant)
 *   PENDING | RUNNING               → IN_PROGRESS    (queued, or a worker is on it)
 *   SUCCEEDED                       → DONE
 *   AWAITING_INPUT                  → WAITING_ON_IT  (paused on a manual step)
 *   FAILED | COMPENSATED            → WAITING_ON_IT  (failed; a compensated run is a failure whose
 *                                                     external effects were rolled back)
 *
 * The four values are all a requester ever sees: no workflow name, step or error crosses this line,
 * so run history stays behind `workflow:read`.
 */
export function provisioningFromRunStatus(
  status: WorkflowRunStatus | null | undefined,
): GrantProvisioning {
  if (status == null) {
    return 'NONE';
  }
  switch (status) {
    case 'PENDING':
    case 'RUNNING':
      return 'IN_PROGRESS';
    case 'SUCCEEDED':
      return 'DONE';
    case 'AWAITING_INPUT':
    case 'FAILED':
    case 'COMPENSATED':
      return 'WAITING_ON_IT';
    default: {
      // Exhaustive over the run state machine; a run state added later reads as "waiting on IT"
      // (the safe, honest default) until it is mapped here.
      const unmapped: never = status;
      void unmapped;
      return 'WAITING_ON_IT';
    }
  }
}

/** One linked run as the batched read selects it. */
export interface LinkedRun {
  accessGrantId: string | null;
  status: WorkflowRunStatus;
}

/**
 * Reduce the runs of a page of grants to one coarse status per grant. `runs` MUST already be ordered
 * newest first (the latest replay first), so the first run seen per grant is its latest. A grant with no
 * run maps to `NONE`.
 */
export function provisioningByGrant(
  grantIds: readonly string[],
  runs: readonly LinkedRun[],
): Map<string, GrantProvisioning> {
  const latest = new Map<string, WorkflowRunStatus>();
  for (const run of runs) {
    if (run.accessGrantId != null && !latest.has(run.accessGrantId)) {
      latest.set(run.accessGrantId, run.status);
    }
  }
  return new Map(
    grantIds.map((id) => [id, provisioningFromRunStatus(latest.get(id))]),
  );
}
