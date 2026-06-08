import type {
  CreateApplicationWorkflow,
  CreateWorkflowVersion,
  UpdateApplicationWorkflow,
} from "@lazyit/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createWorkflow,
  createWorkflowVersion,
  deleteWorkflow,
  updateWorkflow,
} from "../endpoints/workflows";
import { workflowKeys } from "./use-workflows";

/**
 * Write hooks for the workflow definitions (ADR-0020). Each invalidates the `workflows` `all` prefix
 * (refetching both lists and the affected detail); version authoring also invalidates the workflow's
 * detail so the builder re-reads the freshly-authored graph.
 */

/** Create an opt-in workflow header (disabled until a version is authored). */
export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateApplicationWorkflow) => createWorkflow(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

/** Patch a workflow header (name/description/enabled/deprovisionPolicy). */
export function useUpdateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateApplicationWorkflow;
    }) => updateWorkflow(id, data),
    onSuccess: (_workflow, { id }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
      queryClient.invalidateQueries({ queryKey: workflowKeys.detail(id) });
    },
  });
}

/** Soft-delete a workflow. Invalidates the list so the row disappears. */
export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
  });
}

/**
 * Author a new immutable version from the builder's step graph. On error the builder calls
 * `parseWorkflowGraphError` to map the field-addressable 400 onto the offending box; on success it
 * invalidates the workflow detail so the saved graph is re-read.
 */
export function useCreateWorkflowVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CreateWorkflowVersion }) =>
      createWorkflowVersion(id, data),
    onSuccess: (_version, { id }) => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
      queryClient.invalidateQueries({ queryKey: workflowKeys.detail(id) });
    },
  });
}
