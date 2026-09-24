import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type {
  AiConnectionDraft,
  AiConnectionTestResult,
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
    // The body may carry the provider key: drop the finished mutation from the cache at once.
    gcTime: 0,
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
    // The draft may carry a typed provider key: never keep it in the mutation cache.
    gcTime: 0,
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

/**
 * Key hygiene for the forms that may send the provider key (G4 review F1). A TanStack mutation keeps its
 * `variables` — the request body, key included — until it is reset and garbage-collected. These wrappers
 * copy what the UI needs (the error, the test result) into component state and `reset()` the mutation as
 * soon as it settles, so with `gcTime: 0` the body is dropped from memory right after the request.
 */
export function useAiConfigSave() {
  const mutation = useUpdateAiConfig();
  const { mutate, reset } = mutation;
  const [error, setError] = useState<unknown>(null);

  const save = useCallback(
    (body: UpdateAiSettings, onSuccess?: () => void) => {
      setError(null);
      mutate(body, {
        onSuccess: () => onSuccess?.(),
        onError: (err) => setError(err),
        onSettled: () => reset(),
      });
    },
    [mutate, reset],
  );
  const clearError = useCallback(() => setError(null), []);

  return { save, isPending: mutation.isPending, error, clearError };
}

/** {@link useAiConfigSave}'s counterpart for `POST /config/ai/test`. */
export function useAiConnectionTest() {
  const mutation = useTestAiConnection();
  const { mutate, reset } = mutation;
  const [result, setResult] = useState<AiConnectionTestResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(
    (draft: AiConnectionDraft) => {
      setResult(null);
      setError(null);
      mutate(draft, {
        onSuccess: (data) => setResult(data),
        onError: (err) => setError(err),
        onSettled: () => reset(),
      });
    },
    [mutate, reset],
  );
  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { run, isPending: mutation.isPending, result, error, clear };
}
