import type { InstanceVersion } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access for the `/instance` identity surface (ADR-0083) — the ONLY place that talks to
 * `apiFetch` for it. The hook (../hooks/use-instance-version.ts) wraps it in TanStack Query; the
 * Settings → Instance view consumes the hook. Routes mirror apps/api/src/instance.
 */
const BASE = "/instance";

/**
 * The running build's version identity (`GET /instance/version`) — `{ current, gitSha }` baked into
 * the api image at build time (git tag via `git describe`; `"dev"`/`"unknown"` outside a build).
 * Authenticated read, no permission gate.
 *
 * `token` is the optional SSR Bearer override (ADR-0067): the Settings → Instance Server Component
 * passes `session.accessToken` to prefetch this read; client callers omit it and `apiFetch` falls
 * back to the browser-only session-token store, unchanged.
 */
export function getInstanceVersion(token?: string): Promise<InstanceVersion> {
  return apiFetch<InstanceVersion>(`${BASE}/version`, { token });
}
