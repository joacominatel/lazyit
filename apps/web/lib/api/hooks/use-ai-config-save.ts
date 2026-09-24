"use client";

import type {
  AiConnectionDraft,
  AiConnectionTestResult,
  UpdateAiSettings,
} from "@lazyit/shared";
import { useCallback, useState } from "react";
import { useTestAiConnection, useUpdateAiConfig } from "./use-ai-config";

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
