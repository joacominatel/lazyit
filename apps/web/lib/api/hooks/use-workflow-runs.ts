import type { RetryRunOverrides } from "@lazyit/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  dryRunWorkflow,
  getWorkflowRun,
  getWorkflowRuns,
  isTerminalRunStatus,
  replayLatestWorkflowRun,
  retryWorkflowRun,
  type WorkflowDryRunInput,
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

/**
 * C4 — dry-run a workflow against a sample grant (`POST /workflow-runs/dry-run`). A PURE preview with
 * NO side effects (no external call, no ledger rows), so there is no cache to invalidate: callers read
 * the returned {@link DryRunResult} straight off the mutation and render it in the run-timeline grammar.
 * Gated `workflow:manage` at the UI; the API guard is the real gate.
 */
export function useDryRunWorkflow() {
  return useMutation({
    mutationFn: (body: WorkflowDryRunInput) => dryRunWorkflow(body),
  });
}

/**
 * Manually retry a terminal FAILED run from the step that failed onward (`POST /workflow-runs/:id/retry`,
 * issue #308). Gated `workflow:run` at the API (the real gate). On success the run flips back to RUNNING,
 * so we invalidate BOTH the run detail (whose poll then resumes until it re-terminates) and any run lists
 * (the recent-runs panel reflects the new status). Errors (409 not-FAILED / 422 no-resolvable-step / a
 * broker hiccup) bubble to the caller, which surfaces them via `notifyError`.
 *
 * The OPTIONAL `overrides` (ADR-0057 Option 2) is a request-scoped, NEVER-persisted payload override for
 * the failed step's mapping (INV-6) — a plain retry omits it and keeps the unchanged behaviour. The
 * override applies to the NEXT attempt ONLY; it does not edit the definition or fix future runs.
 */
export function useRetryWorkflowRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      overrides,
    }: {
      id: string;
      overrides?: RetryRunOverrides;
    }) => retryWorkflowRun(id, overrides),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(result.runId),
      });
      queryClient.invalidateQueries({ queryKey: workflowRunKeys.all });
    },
  });
}

/**
 * Clone-to-new-run from the LATEST workflow version (`POST /workflow-runs/:id/replay-latest`, ADR-0057
 * Option 3). Gated `workflow:run` at the API (the real gate). A FRESH run is created on the current
 * version for the same grant; the source FAILED run stays immutable. On success we invalidate the run
 * lists (the recent-runs panel gains the new run) and the NEW run's detail (so its poll is primed); the
 * caller navigates to `result.runId`. Errors (409 source not-FAILED / 422 fail-closed double-provision
 * guard → re-grant / a broker hiccup) bubble to the caller, which surfaces them via `notifyError`.
 */
export function useReplayLatestWorkflowRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => replayLatestWorkflowRun(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(result.runId),
      });
      queryClient.invalidateQueries({ queryKey: workflowRunKeys.all });
    },
  });
}
