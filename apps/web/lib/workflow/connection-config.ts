import type {
  WorkflowConnectionConfig,
  WorkflowProbeMethod,
  WorkflowRestAuthScheme,
} from "@lazyit/shared";

/**
 * Build the per-kind `WorkflowConnection.config` object from the flat connection-form state
 * (frontend.md §4 — the connection create/edit dialog).
 *
 * EDIT-SAFETY (issue #351): a PATCH replaces the WHOLE `config` jsonb, so rebuilding it from only
 * the form-visible fields silently DROPS any config key the form does not expose — notably the REST
 * `defaultHeaders` (a static `Accept`/etc. map the test-connection probe already applies). The form
 * has no editor for it yet, so an edit must CARRY IT OVER rather than reconstruct from scratch. We
 * therefore start from `existing` (the connection being edited, when present) and override only the
 * fields the form owns; an unset form field clears the key it owns (it is authoritative for those),
 * but unrelated keys like `defaultHeaders` survive the round-trip. On a create there is no `existing`
 * and the result is exactly the form's fields.
 *
 * Pure + framework-agnostic so it is unit-testable in `connection-config.test.ts` (the area had no
 * test before; this closes the latent data-loss bug under test).
 */
export interface ConnectionConfigInput {
  kind: WorkflowConnectionConfig["kind"];
  /** REST baseUrl / WEBHOOK_OUT url — trimmed here. */
  url: string;
  authScheme: WorkflowRestAuthScheme;
  authHeaderName: string;
  signatureHeader: string;
  healthCheckPath: string;
  healthCheckMethod: WorkflowProbeMethod | undefined;
}

export function buildConnectionConfig(
  values: ConnectionConfigInput,
  /** The config of the connection being edited; `undefined` on a create. */
  existing?: WorkflowConnectionConfig,
): WorkflowConnectionConfig {
  switch (values.kind) {
    case "REST": {
      // Preserve unrelated REST keys (e.g. `defaultHeaders`) the form does not expose — only when the
      // existing config is also REST (a kind never changes on edit, but this keeps the union sound)
      // and the key is actually set (no explicit `undefined` key on a fresh config).
      const preserved =
        existing?.kind === "REST" && existing.defaultHeaders
          ? { defaultHeaders: existing.defaultHeaders }
          : {};
      return {
        ...preserved,
        kind: "REST",
        baseUrl: values.url.trim(),
        authScheme: values.authScheme,
        ...(values.authScheme === "HEADER" && values.authHeaderName.trim()
          ? { authHeaderName: values.authHeaderName.trim() }
          : {}),
        ...(values.healthCheckPath.trim()
          ? { healthCheckPath: values.healthCheckPath.trim() }
          : {}),
        ...(values.healthCheckMethod
          ? { healthCheckMethod: values.healthCheckMethod }
          : {}),
      };
    }
    case "WEBHOOK_OUT":
      return {
        kind: "WEBHOOK_OUT",
        url: values.url.trim(),
        ...(values.signatureHeader.trim()
          ? { signatureHeader: values.signatureHeader.trim() }
          : {}),
      };
    case "MANUAL":
      return { kind: "MANUAL" };
  }
}
