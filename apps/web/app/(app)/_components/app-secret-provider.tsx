"use client";

import { SecretManagerProvider } from "@/app/(app)/secrets/_components/secret-session";

/**
 * Wraps the `(app)` shell in the `SecretManagerProvider` session so the in-memory secret material
 * (the unlocked X25519 private key + the per-vault DEK cache) is available app-wide — not just
 * under `/secrets`. This allows KB articles to render `{{ lazyit_secret.HANDLE }}` chips and call
 * the session's decrypt path from any route under `(app)` (ADR-0061 §8, provider hoist).
 *
 * The session still clears on `lock()` (explicit user action) and implicitly on unmount (navigating
 * out of the `(app)` group — e.g. logout to `/login`). The `/secrets` layout retains its own
 * `secret:read` access gate (the manager UI is ADMIN-only) but no longer needs to mount the
 * provider itself — it is already available from this outer shell.
 */
export function AppSecretProvider({ children }: { children: React.ReactNode }) {
  return <SecretManagerProvider>{children}</SecretManagerProvider>;
}
