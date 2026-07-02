import { z } from "zod";

/**
 * Instance identity contracts (ADR-0083 — tag-driven semver versioning).
 *
 * `GET /instance/version` — the running build's version identity, baked at IMAGE BUILD time from the
 * git checkout (`--build-arg APP_VERSION/GIT_SHA` → `ENV`, see infra/docker/*.Dockerfile) and read
 * from env at runtime. Authenticated read (no permission gate); displayed on Settings → Instance.
 *
 *   - `current` — `git describe --tags --always` at build: a clean release reads `v1.4.2`; an
 *     off-tag rebuild honestly reads `v1.4.2-3-gabc1234`; a non-image dev run falls back to `"dev"`.
 *   - `gitSha`  — the short commit SHA the image was built from; `"unknown"` when not injected.
 *
 * This is the identity HALF only — "latest known" / "N behind" belongs to ADR-0084 (deferred).
 */
export const InstanceVersionSchema = z.object({
  current: z.string().min(1),
  gitSha: z.string().min(1),
});
export type InstanceVersion = z.infer<typeof InstanceVersionSchema>;
