import type { CreateWorkflowConnection } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkflowConnection,
  deleteWorkflowConnection,
  getWorkflowConnection,
  getWorkflowConnections,
  testWorkflowConnection,
  type UpdateWorkflowConnection,
  updateWorkflowConnection,
} from "../endpoints/workflow-connections";
import { createQueryKeys } from "../query-keys";

/**
 * Read + write hooks for `WorkflowConnection` (ADR-0020 + ADR-0054 §4). The list is keyed by the
 * `applicationId` scope; mutations invalidate the `all` prefix so the per-app connection card refetches.
 */
const baseConnectionKeys = createQueryKeys("workflow-connections");
export const workflowConnectionKeys = {
  ...baseConnectionKeys,
  list: (applicationId: string | undefined) =>
    [...baseConnectionKeys.all, "list", { applicationId }] as const,
};

/** List connections for an application (or all when `applicationId` is omitted). */
export function useWorkflowConnections(applicationId: string | undefined) {
  return useQuery({
    queryKey: workflowConnectionKeys.list(applicationId),
    queryFn: () => getWorkflowConnections(applicationId),
  });
}

/** Fetch one connection by id; idle until an id is provided. */
export function useWorkflowConnection(id: string | undefined) {
  return useQuery({
    queryKey: workflowConnectionKeys.detail(id ?? ""),
    queryFn: () => getWorkflowConnection(id as string),
    enabled: Boolean(id),
  });
}

/** Create a connection. Invalidates the list so the new connection appears. */
export function useCreateWorkflowConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkflowConnection) =>
      createWorkflowConnection(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowConnectionKeys.all }),
  });
}

/** Patch a connection's name/config/secret reference (kind immutable). */
export function useUpdateWorkflowConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateWorkflowConnection;
    }) => updateWorkflowConnection(id, data),
    onSuccess: (_connection, { id }) => {
      queryClient.invalidateQueries({ queryKey: workflowConnectionKeys.all });
      queryClient.invalidateQueries({
        queryKey: workflowConnectionKeys.detail(id),
      });
    },
  });
}

/**
 * C3 — probe a connection's connectivity + credential (`POST /workflow-connections/:id/test`). A
 * READ-ONLY check with NO side effects, so there is nothing to invalidate: callers read the returned
 * {@link TestConnectionResult} (`ok` / `message` / `requestId`) straight off the mutation. Gated
 * `workflow:manage` at the UI; the API guard is the real gate.
 */
export function useTestWorkflowConnection() {
  return useMutation({
    mutationFn: (id: string) => testWorkflowConnection(id),
  });
}

/** Soft-delete a connection. Invalidates the list. */
export function useDeleteWorkflowConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflowConnection(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowConnectionKeys.all }),
  });
}
