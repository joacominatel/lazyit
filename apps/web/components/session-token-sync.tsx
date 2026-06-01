"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { setSessionToken } from "@/lib/api/session-token";

/**
 * Invisible component that syncs the Auth.js access token into the client-side
 * session-token store so apiFetch can attach it as a Bearer header automatically.
 *
 * Rendered once in the (app) group layout — runs after hydration, before any
 * TanStack Query queryFns fire on the client. Works in tandem with the explicit
 * `token` parameter on apiFetch for server-component callers (ADR-0039).
 */
export function SessionTokenSync() {
  const { data: session } = useSession();

  useEffect(() => {
    setSessionToken(session?.accessToken);
  }, [session?.accessToken]);

  return null;
}
