/**
 * Thin, typed fetch wrapper for the lazyit API.
 *
 * Base URL resolution (ADR-0026 / issue-409):
 *   - Server side (SSR / server components / proxy.ts): prefers INTERNAL_API_URL (an absolute
 *     Docker-internal URL, e.g. http://api:3001) so Node's undici fetch gets a valid origin.
 *     Falls back to NEXT_PUBLIC_API_URL then http://localhost:3001.
 *   - Client side (browser): NEXT_PUBLIC_API_URL is baked as the relative `/api` at build time
 *     (domain-portable per ADR-0026); INTERNAL_API_URL is never exposed to the browser.
 *
 * Authentication is handled by Auth.js v5 (ADR-0039): the Bearer token is resolved in this order:
 *   1. Explicit `token` option passed by the caller (server components use `await auth()`)
 *   2. Client-side session-token store (populated by SessionTokenSync in the app layout)
 *   3. Unauthenticated (public/health endpoints only)
 *
 * The former `X-User-Id` dev shim (ADR-0022) has been removed. The backend
 * now validates OIDC Bearer JWTs via its global auth guard (ADR-0038).
 */

import { getSessionToken } from "./session-token";

/**
 * Absolute API base for the current execution context.
 *
 * On the server, Node's `fetch` (undici) requires an absolute URL — a relative `/api` throws
 * "Failed to parse URL". INTERNAL_API_URL is set on the web container at runtime (compose.yaml)
 * to the Docker-internal address (http://api:3001) and is only ever read server-side (it is
 * NOT prefixed `NEXT_PUBLIC_` so it is never baked into the client bundle).
 *
 * In the browser `typeof window !== 'undefined'` is true so we fall through to
 * NEXT_PUBLIC_API_URL (baked as `/api` at build time, reaching the API via Caddy — ADR-0026).
 */
const API_URL: string =
  typeof window === "undefined"
    ? // Server: absolute internal URL preferred; fall back gracefully for local `bun run dev`.
      (process.env.INTERNAL_API_URL ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:3001")
    : // Browser: always use the build-time public base (relative `/api` or an explicit origin).
      (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001");

/** Thrown when the API responds with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
    /**
     * The API's `X-Request-Id` for this response (ADR-0031), when the server sent it and CORS
     * exposed it. Surfaced in the error UX so a user can quote it when reporting a failure.
     */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** Plain value serialized to JSON. Omit for bodyless requests (GET/DELETE). */
  body?: unknown;
  /**
   * Bearer token for the API. Comes from the Auth.js session (`session.accessToken`).
   * Omit only for genuinely public endpoints (e.g. health check).
   */
  token?: string;
}

/**
 * Fetch `path` (relative to the API base URL) and return the parsed JSON body
 * typed as `T`. Throws `ApiError` on non-2xx responses.
 */
export async function apiFetch<T>(
  path: string,
  { body, token, headers, ...init }: ApiFetchOptions = {},
): Promise<T> {
  // FormData (file uploads) must be sent as-is so the browser sets the
  // multipart boundary; only plain values are JSON-serialized.
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  // Explicit token takes priority; fall back to the client-side session store
  // (populated by SessionTokenSync) so hooks don't need to thread the token manually.
  const resolvedToken = token ?? getSessionToken();

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(body !== undefined && !isFormData
        ? { "Content-Type": "application/json" }
        : {}),
      ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : isFormData
          ? (body as BodyInit)
          : JSON.stringify(body),
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    const message =
      (payload as { message?: string } | undefined)?.message ??
      `API request failed: ${res.status} ${res.statusText}`;
    // Header lookup is case-insensitive; the API sends it as `X-Request-Id`.
    const requestId = res.headers.get("x-request-id") ?? undefined;
    throw new ApiError(res.status, message, payload, requestId);
  }

  return payload as T;
}

/**
 * Fetch `path` and return the raw response BODY as a `Blob` (not JSON-parsed) — for authenticated file
 * downloads where the API streams an attachment (e.g. the activity-log CSV export, issue #840). The
 * API is Bearer-authenticated, so a plain `<a href>` can't carry the token; this resolves the same
 * Bearer as {@link apiFetch} and hands back a Blob the caller can turn into a browser download.
 * Throws {@link ApiError} on a non-2xx response (best-effort JSON message).
 */
export async function apiFetchBlob(
  path: string,
  { token, headers, ...init }: Omit<ApiFetchOptions, "body"> = {},
): Promise<Blob> {
  const resolvedToken = token ?? getSessionToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    const isJson = res.headers
      .get("content-type")
      ?.includes("application/json");
    const payload = isJson ? await res.json().catch(() => undefined) : undefined;
    const message =
      (payload as { message?: string } | undefined)?.message ??
      `API request failed: ${res.status} ${res.statusText}`;
    const requestId = res.headers.get("x-request-id") ?? undefined;
    throw new ApiError(res.status, message, payload, requestId);
  }

  return res.blob();
}
