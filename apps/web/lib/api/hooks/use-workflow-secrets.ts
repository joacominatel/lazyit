import type { CreateWorkflowSecret } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkflowSecret,
  deleteWorkflowSecret,
  getWorkflowSecrets,
  rotateWorkflowSecret,
} from "../endpoints/workflow-secrets";
import { createQueryKeys } from "../query-keys";

/**
 * Read + write hooks for `WorkflowSecret` (ADR-0020 + ADR-0054 §5). Reads return the REDACTED
 * descriptor only — the cleartext is write-only and is deliberately NEVER written to the query cache
 * (mirroring the service-account create flow). Mutations invalidate the `all` prefix so the masked
 * field re-reads `configured`/`label`. The list is keyed by the `applicationId` scope.
 */
const baseSecretKeys = createQueryKeys("workflow-secrets");
export const workflowSecretKeys = {
  ...baseSecretKeys,
  list: (applicationId: string | undefined) =>
    [...baseSecretKeys.all, "list", { applicationId }] as const,
};

/** List redacted secret descriptors for an application (or all). Never carries a value. */
export function useWorkflowSecrets(applicationId: string | undefined) {
  return useQuery({
    queryKey: workflowSecretKeys.list(applicationId),
    queryFn: () => getWorkflowSecrets(applicationId),
  });
}

/**
 * Create a secret. The cleartext `value` is sent once and the redacted descriptor returned; we only
 * invalidate `all` (never cache the result body) so the cleartext leaves no trace in TanStack's store.
 */
export function useCreateWorkflowSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkflowSecret) => createWorkflowSecret(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowSecretKeys.all }),
  });
}

/** Rotate a secret's value (Replace). Like create, the new value is never cached — only `all` invalidates. */
export function useRotateWorkflowSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      rotateWorkflowSecret(id, value),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowSecretKeys.all }),
  });
}

/** Delete a secret. Invalidates the list so the field reverts to "not configured". */
export function useDeleteWorkflowSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflowSecret(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowSecretKeys.all }),
  });
}
