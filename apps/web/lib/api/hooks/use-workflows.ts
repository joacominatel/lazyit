import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getWorkflow,
  getWorkflows,
  type WorkflowFilters,
} from "../endpoints/workflows";
import { createQueryKeys } from "../query-keys";

/**
 * Read hooks + query-key factory for the Applications Workflow Engine definitions (ADR-0020 shape +
 * ADR-0054). `all` → `["workflows"]`; `list(filters)` keys by the scope so the per-app tab and the
 * cross-app hub cache distinctly; `detail(id)` holds the header + latest version graph. Writes live in
 * use-workflow-mutations and invalidate the `all` prefix.
 */
const baseWorkflowKeys = createQueryKeys("workflows");
export const workflowKeys = {
  ...baseWorkflowKeys,
  list: (filters: WorkflowFilters) =>
    [...baseWorkflowKeys.all, "list", filters] as const,
};

/** List workflows (optionally scoped to an application), paged. Returns the `Page<ApplicationWorkflow>`. */
export function useWorkflows(filters: WorkflowFilters = {}) {
  return useQuery({
    queryKey: workflowKeys.list(filters),
    queryFn: () => getWorkflows(filters),
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch one workflow with its latest version's full step graph; idle until an id is provided. The
 * builder reads this to render the diagram and re-open it for editing.
 */
export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: workflowKeys.detail(id ?? ""),
    queryFn: () => getWorkflow(id as string),
    enabled: Boolean(id),
  });
}
