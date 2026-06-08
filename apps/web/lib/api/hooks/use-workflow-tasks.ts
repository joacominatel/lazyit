import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  failWorkflowTask,
  getWorkflowTask,
  getWorkflowTasks,
  skipWorkflowTask,
  submitWorkflowTask,
  type WorkflowTaskFilters,
} from "../endpoints/workflow-tasks";
import { workflowRunKeys } from "./use-workflow-runs";
import { createQueryKeys } from "../query-keys";

/**
 * Read + action hooks for `ManualTask` — the human-in-the-loop inbox (ADR-0020 + ADR-0054 §6). Until
 * the ADR-0052 bell/SSE lands, the inbox is POLLED: the pending list refetches on an interval so a new
 * "needs a human" task surfaces without a manual reload. Acting on a task invalidates BOTH the task
 * list and the resumed run's detail (the action result carries the `runId`).
 */
const baseTaskKeys = createQueryKeys("workflow-tasks");
export const workflowTaskKeys = {
  ...baseTaskKeys,
  list: (filters: WorkflowTaskFilters) =>
    [...baseTaskKeys.all, "list", filters] as const,
};

/** Poll the pending inbox at this cadence (polled fallback for the not-yet-shipped SSE bell). */
const TASK_POLL_INTERVAL_MS = 15000;

/**
 * List manual tasks (the inbox), filtered and paged. Defaults to the PENDING queue server-side; the
 * pending view polls so new tasks appear, while archived/other views do not.
 */
export function useWorkflowTasks(filters: WorkflowTaskFilters = {}) {
  const isPending = filters.status === undefined || filters.status === "PENDING";
  return useQuery({
    queryKey: workflowTaskKeys.list(filters),
    queryFn: () => getWorkflowTasks(filters),
    placeholderData: keepPreviousData,
    refetchInterval: isPending ? TASK_POLL_INTERVAL_MS : false,
  });
}

/** Fetch one task with its `origin` + `inputFields`; idle until an id is provided. */
export function useWorkflowTask(id: string | undefined) {
  return useQuery({
    queryKey: workflowTaskKeys.detail(id ?? ""),
    queryFn: () => getWorkflowTask(id as string),
    enabled: Boolean(id),
  });
}

/** Invalidate the task list + the resumed run after any task action. */
function invalidateAfterAction(
  queryClient: ReturnType<typeof useQueryClient>,
  taskId: string,
  runId: string | undefined,
) {
  queryClient.invalidateQueries({ queryKey: workflowTaskKeys.all });
  queryClient.invalidateQueries({ queryKey: workflowTaskKeys.detail(taskId) });
  if (runId) {
    queryClient.invalidateQueries({ queryKey: workflowRunKeys.detail(runId) });
  }
}

/** Submit a task's typed input → resume the run. */
export function useSubmitWorkflowTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Record<string, unknown>;
    }) => submitWorkflowTask(id, input),
    onSuccess: (result, { id }) =>
      invalidateAfterAction(queryClient, id, result.runId),
  });
}

/** Skip an optional task step → resume the run past it. */
export function useSkipWorkflowTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => skipWorkflowTask(id),
    onSuccess: (result, id) =>
      invalidateAfterAction(queryClient, id, result.runId),
  });
}

/** Fail the run from this task, with an optional reason. */
export function useFailWorkflowTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      failWorkflowTask(id, reason),
    onSuccess: (result, { id }) =>
      invalidateAfterAction(queryClient, id, result.runId),
  });
}
