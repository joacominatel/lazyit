import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPolicyOverride, AgentPolicySettings } from "@lazyit/shared";
import { getAgentPolicy, putAgentPolicy } from "../endpoints/infra";
import { infraKeys } from "./use-infra-nodes";

/**
 * The instance-default reporting-agent policy (ADR-0074 §7 amendment, issue #1140) — the read the
 * Settings → Instance panel edits, and the read the topology drill-in compares each node's echoed
 * `policyRevision` against to say *applied* vs *pending*.
 *
 * Keyed under the existing `infra` namespace so a policy write and the node reads it changes the
 * meaning of invalidate together — a saved policy must never leave a panel showing "v7 applied"
 * against a v8 instance.
 */
export const agentPolicyKey = () => [...infraKeys.all, "agent-policy"] as const;

/**
 * Read the instance default + the current revision. Long `staleTime`: this changes only when an
 * operator saves it, and the drill-in reads it on every panel open purely to compare one integer.
 */
export function useAgentPolicy() {
  return useQuery({
    queryKey: agentPolicyKey(),
    // Destructured rather than passed bare: `getAgentPolicy` takes an AbortSignal, and handing it
    // TanStack's whole QueryFunctionContext would type-check as `unknown` and quietly send no signal.
    queryFn: ({ signal }) => getAgentPolicy(signal),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Save the instance-default policy. Invalidates the whole `infra` namespace, not just this key:
 * every node's *applied vs pending* badge is derived from the revision this write just bumped, so
 * leaving the node caches alone would render a fleet as "applied" against a policy it has not seen.
 */
export function useSaveAgentPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentPolicyOverride): Promise<AgentPolicySettings> =>
      putAgentPolicy(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infraKeys.all });
    },
  });
}
