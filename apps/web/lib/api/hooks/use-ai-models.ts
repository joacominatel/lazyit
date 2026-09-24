import { useQuery } from "@tanstack/react-query";
import { getAiModels } from "../endpoints/ai";
import { aiKeys } from "./use-ai-status";

/** The model catalog's key, under the assistant's `["ai"]` root (never refetched by a tool result). */
export const aiModelKeys = {
  catalog: () => [...aiKeys.all, "models"] as const,
};

/**
 * What the chat's model picker offers (`GET /ai/models`, #1373): the configured provider's models, the
 * admin's default model and effort, and which knobs the provider takes. Read when the chat opens; the API
 * caches the provider's list for 10 minutes, so five minutes of client staleness is plenty. A refusal
 * (409 `AI_DISABLED`, 403) is never retried (the global 4xx policy): the picker then offers free text only.
 */
export function useAiModels(enabled = true) {
  return useQuery({
    queryKey: aiModelKeys.catalog(),
    queryFn: () => getAiModels(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
