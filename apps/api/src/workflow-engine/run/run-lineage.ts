import type { WorkflowRunStatus, WorkflowTrigger } from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';

// FAILED and COMPENSATED are absent: neither holds an external effect a second re-drive would duplicate.
const LIVE_LINEAGE_STATUSES: WorkflowRunStatus[] = [
  'PENDING',
  'RUNNING',
  'AWAITING_INPUT',
  'SUCCEEDED',
];

export class RunLineageBusyError extends Error {
  constructor(
    readonly liveRunId: string,
    readonly liveStatus: string,
  ) {
    super(
      `Run ${liveRunId} for this grant is already ${liveStatus}; re-driving another run would provision twice — work on run ${liveRunId} instead`,
    );
    this.name = 'RunLineageBusyError';
  }
}

// Must run inside an interactive transaction: the xact lock holds until the caller's CAS or create commits.
export async function lockLineageAndAssertIdle(
  tx: Prisma.TransactionClient,
  trigger: WorkflowTrigger,
  accessGrantId: string,
  excludeRunId?: string,
): Promise<void> {
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the pg adapter cannot deserialize.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'lazyit.workflow_run_lineage'}), hashtext(${`${trigger}:${accessGrantId}`}))`;
  const live = await tx.workflowRun.findFirst({
    where: {
      trigger,
      accessGrantId,
      status: { in: LIVE_LINEAGE_STATUSES },
      ...(excludeRunId ? { id: { not: excludeRunId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (live) {
    throw new RunLineageBusyError(live.id, live.status);
  }
}
