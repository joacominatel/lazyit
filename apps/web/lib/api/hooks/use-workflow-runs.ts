import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getWorkflowRun,
  getWorkflowRuns,
  isTerminalRunStatus,
  type WorkflowRunFilters,
} from "../endpoints/workflow-runs";
import { createQueryKeys } from "../query-keys";

/**
 * Read hooks + query-key factory for `WorkflowRun` (ADR-0020 + ADR-0054 §4). Runs are engine-written,
 * so there are no mutations here. The list does NOT poll (refetch-on-focus is enough — frontend.md §10
 * "list pages → no realtime"); the DETAIL polls with `refetchInterval` ONLY while the run is
 * non-terminal, stopping the moment it reaches SUCCEEDED/FAILED/COMPENSATED — no idle polling, and the
 * dependency-free fallback for live status until the SSE channel ships (C-realtime, NOT in scope here).
 */
const baseRunKeys = createQueryKeys("workflow-runs");
export const workflowRunKeys = {
  ...baseRunKeys,
  list: (filters: WorkflowRunFilters) =>
    [...baseRunKeys.all, "list", filters] as const,
};

/** While a non-terminal run is open, re-read its status every few seconds. */
const RUN_POLL_INTERVAL_MS = 4000;

/** List runs (filtered, paged). Returns the `Page<WorkflowRun>` envelope. No realtime. */
export function useWorkflowRuns(filters: WorkflowRunFilters = {}) {
  return useQuery({
    queryKey: workflowRunKeys.list(filters),
    queryFn: () => getWorkflowRuns(filters),
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch one run with its traversed step graph; idle until an id is provided. Polls while the run is
 * non-terminal and stops automatically once it terminates (the `refetchInterval` callback returns
 * `false`), so an open timeline ticks live without idle polling.
 */
export function useWorkflowRun(id: string | undefined) {
  return useQuery({
    queryKey: workflowRunKeys.detail(id ?? ""),
    queryFn: () => getWorkflowRun(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return RUN_POLL_INTERVAL_MS;
      return isTerminalRunStatus(status) ? false : RUN_POLL_INTERVAL_MS;
    },
  });
}
