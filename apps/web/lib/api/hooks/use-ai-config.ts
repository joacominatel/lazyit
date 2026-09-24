import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiConnectionDraft,
  AiServiceAccountSettings,
  UpdateAiSettings,
} from "@lazyit/shared";
import {
  getAiConfig,
  getAiServiceAccountSettings,
  listAiModels,
  testAiConnection,
  updateAiConfig,
  updateAiServiceAccountSettings,
} from "../endpoints/ai-config";
import { aiKeys } from "./use-ai-status";

/**
 * Query keys for the admin AI configuration. Namespaced under `config` (like `smtpKeys`), NOT under the
 * `["ai"]` root: the chat invalidates "everything but the assistant's own state" with an `["ai"]`
 * predicate, and the admin config is not assistant state.
 */
export const aiConfigKeys = {
  all: ["config", "ai"] as const,
  single: () => [...aiConfigKeys.all, "single"] as const,
  serviceAccount: (id: string) =>
    [...aiConfigKeys.all, "service-account", id] as const,
};

/** The AI configuration (`GET /config/ai`, `settings:manage`). Drives Settings → AI. */
export function useAiConfig() {
  return useQuery({
    queryKey: aiConfigKeys.single(),
    queryFn: ({ signal }) => getAiConfig(undefined, signal),
    staleTime: 30 * 1000,
  });
}

/**
 * Save the AI configuration (`PUT /config/ai`). On success the cache takes the persisted (redacted)
 * answer directly — the editor re-seeds from it — and the caller's `/ai/status` is invalidated, since
 * the MCP switch and the chat availability may have changed.
 */
export function useUpdateAiConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAiSettings) => updateAiConfig(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(aiConfigKeys.single(), saved);
      void queryClient.invalidateQueries({ queryKey: aiKeys.status() });
    },
  });
}

/** Test a provider connection (`POST /config/ai/test`). Writes nothing, so it invalidates nothing. */
export function useTestAiConnection() {
  return useMutation({
    mutationFn: (draft: AiConnectionDraft) => testAiConnection(draft),
  });
}

/** Model suggestions for a draft provider (`POST /config/ai/models`). A mutation: it is a POST. */
export function useAiModelSuggestions() {
  return useMutation({
    mutationFn: (draft: AiConnectionDraft) => listAiModels(draft),
  });
}

/** A Service Account's AI access (`GET /config/ai/service-accounts/:id`). */
export function useAiServiceAccountSettings(
  serviceAccountId: string | undefined,
) {
  return useQuery({
    queryKey: aiConfigKeys.serviceAccount(serviceAccountId ?? ""),
    queryFn: ({ signal }) =>
      getAiServiceAccountSettings(serviceAccountId as string, signal),
    enabled: Boolean(serviceAccountId),
  });
}

/** Set a Service Account's AI access (`PUT /config/ai/service-accounts/:id`). */
export function useUpdateAiServiceAccountSettings(serviceAccountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AiServiceAccountSettings) =>
      updateAiServiceAccountSettings(serviceAccountId, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(
        aiConfigKeys.serviceAccount(serviceAccountId),
        saved,
      );
    },
  });
}
