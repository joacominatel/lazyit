"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { setSessionToken } from "@/lib/api/session-token";

/**
 * Invisible component that syncs the Auth.js access token into the client-side
 * session-token store so apiFetch can attach it as a Bearer header automatically.
 *
 * Rendered once in the (app)/(print) group layouts. Because <SessionProvider> is seeded
 * with the server-resolved session in the root layout (issue #498), `useSession()` returns
 * `authenticated` on the FIRST client render — so we write the token to the store *during
 * render*, before this component returns and before any TanStack Query queryFn runs on the
 * client. That eliminates the first-paint token-less window that produced spurious 401s.
 *
 * The token store is a plain module-level variable (lib/api/session-token.ts), so writing it
 * during render is a safe, idempotent side effect (not React state) and avoids the one-tick lag
 * of a post-mount effect. The effect below still mirrors later token transitions — sign-out
 * (token → undefined) or a session refresh swapping the token. Works in tandem with the explicit
 * `token` parameter on apiFetch for server-component callers (ADR-0039).
 */
export function SessionTokenSync() {
  const { data: session } = useSession();

  // Synchronous seed on every render so the very first paint already has the Bearer token.
  setSessionToken(session?.accessToken);

  // Mirror later transitions (sign-out clears it; a refresh swaps it) without an extra render.
  useEffect(() => {
    setSessionToken(session?.accessToken);
  }, [session?.accessToken]);

  return null;
}
