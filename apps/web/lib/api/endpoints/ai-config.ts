import type {
  AiConnectionDraft,
  AiConnectionTestResult,
  AiModelList,
  AiServiceAccountSettings,
  AiSettings,
  UpdateAiSettings,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the instance AI configuration (ADR-0097 decision 7;
 * docs/ai-assistant/frontend.md §7 K2) — the ONLY place that talks to `apiFetch` for `/config/ai`.
 * Hooks (../hooks/use-ai-config.ts) wrap these in TanStack Query; Settings → AI and the Service
 * Account AI-access dialog consume the hooks (ADR-0020).
 *
 * Every route is `settings:manage` and refuses a Service Account. The provider key is WRITE-ONLY: the
 * read shape carries `apiKeySet`, never the key (the SMTP precedent, ADR-0079).
 */
const BASE = "/config/ai";

/**
 * Read the AI configuration (`GET /config/ai`). Never 404s for "unset": an instance nobody configured
 * answers the disabled default.
 */
export function getAiConfig(
  token?: string,
  signal?: AbortSignal,
): Promise<AiSettings> {
  return apiFetch<AiSettings>(BASE, { token, signal });
}

/**
 * Save the whole configuration (`PUT /config/ai`). The key: omit `apiKey` to keep the stored one, a
 * string to set it, `null` to clear it; changing the provider or base URL clears it server side.
 * `enabled: true` runs the enable gate (422 `{ code, message, test? }`); a missing `AI_SECRET_KEY`, shim
 * mode or a concurrent save answer 409.
 */
export function updateAiConfig(body: UpdateAiSettings): Promise<AiSettings> {
  return apiFetch<AiSettings>(BASE, { method: "PUT", body });
}

/**
 * Test a provider connection (`POST /config/ai/test`). The body is a DRAFT overriding the saved fields
 * (the key may be typed inline); `{}` tests the saved configuration. HTTP 200 either way — read `ok`.
 */
export function testAiConnection(
  draft: AiConnectionDraft,
): Promise<AiConnectionTestResult> {
  return apiFetch<AiConnectionTestResult>(`${BASE}/test`, {
    method: "POST",
    body: draft,
  });
}

/** Model suggestions for the draft (or saved) provider (`POST /config/ai/models`). Free text stays allowed. */
export function listAiModels(draft: AiConnectionDraft): Promise<AiModelList> {
  return apiFetch<AiModelList>(`${BASE}/models`, {
    method: "POST",
    body: draft,
  });
}

/**
 * A Service Account's AI access (`GET /config/ai/service-accounts/:id`). An account never configured
 * reads `read-write` with no cap; a revoked or unknown one is 404.
 */
export function getAiServiceAccountSettings(
  serviceAccountId: string,
  signal?: AbortSignal,
): Promise<AiServiceAccountSettings> {
  return apiFetch<AiServiceAccountSettings>(
    `${BASE}/service-accounts/${encodeURIComponent(serviceAccountId)}`,
    { signal },
  );
}

/** Set a Service Account's AI access (`PUT /config/ai/service-accounts/:id`). Audited server side. */
export function updateAiServiceAccountSettings(
  serviceAccountId: string,
  body: AiServiceAccountSettings,
): Promise<AiServiceAccountSettings> {
  return apiFetch<AiServiceAccountSettings>(
    `${BASE}/service-accounts/${encodeURIComponent(serviceAccountId)}`,
    { method: "PUT", body },
  );
}
