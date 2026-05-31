/**
 * Auth.js v5 catch-all route handler.
 *
 * Handles the OIDC callback, session management and sign-out for all
 * Auth.js endpoints under /api/auth/**. The handlers are exported from
 * the central auth.ts config so there is a single source of truth.
 *
 * See ADR-0039.
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
