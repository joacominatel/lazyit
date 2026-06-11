import type {
  WorkflowConnectionConfig,
  WorkflowRestAuthScheme,
} from "@lazyit/shared";

/**
 * The REST auth schemes a credential can actually be bound to (#342). `NONE` is excluded on purpose: a
 * credential with no scheme is an ORPHAN — the engine's `applyAuth` attaches nothing for `NONE`, so the
 * secret would be silently ignored. Adding a credential to a REST connection therefore always picks a
 * REAL scheme; this is the contract the connection card's guided add-credential flow renders.
 */
export const BINDABLE_AUTH_SCHEMES = ["BEARER", "BASIC", "HEADER"] as const;
export type BindableAuthScheme = (typeof BINDABLE_AUTH_SCHEMES)[number];

/**
 * Derive the connection-config patch that SETS the chosen auth scheme as part of binding a credential
 * (#342, Option B "guide it"). Pure + framework-agnostic so it is unit-testable away from the React
 * component and the two sides (UI + the eventual API patch) agree by construction.
 *
 * Outcomes:
 *  - `{ ok: true, patch }`            — the connection's REST config must be updated to the chosen scheme
 *                                       (and header name for HEADER) before the secret is bound.
 *  - `{ ok: true, patch: undefined }` — nothing to change: non-REST, OR the scheme is already exactly
 *                                       what was chosen (binding only needs the secret).
 *  - `{ ok: false, reason: "header-name-required" }` — a HEADER scheme was chosen with no header name;
 *                                       the caller must refuse to save (the API would 400 otherwise).
 *
 * The patch is built off the EXISTING config (spread) so unrelated fields (baseUrl, defaultHeaders,
 * healthCheckPath/Method) are preserved; only `authScheme`/`authHeaderName` change. A non-HEADER scheme
 * clears `authHeaderName` (it is meaningless for BEARER/BASIC).
 */
export function deriveSchemePatch(args: {
  config: WorkflowConnectionConfig;
  scheme: BindableAuthScheme;
  headerName: string;
}):
  | { ok: true; patch: WorkflowConnectionConfig | undefined }
  | { ok: false; reason: "header-name-required" } {
  const { config, scheme, headerName } = args;
  if (config.kind !== "REST") {
    return { ok: true, patch: undefined };
  }
  const headerNeeded = scheme === "HEADER";
  const trimmedHeader = headerName.trim();
  if (headerNeeded && trimmedHeader.length === 0) {
    return { ok: false, reason: "header-name-required" };
  }
  const currentScheme: WorkflowRestAuthScheme = config.authScheme;
  const unchanged =
    currentScheme === scheme &&
    (!headerNeeded || (config.authHeaderName ?? "") === trimmedHeader);
  if (unchanged) {
    return { ok: true, patch: undefined };
  }
  return {
    ok: true,
    patch: {
      ...config,
      authScheme: scheme,
      ...(headerNeeded
        ? { authHeaderName: trimmedHeader }
        : { authHeaderName: undefined }),
    },
  };
}
