/**
 * Thin, typed fetch wrapper for the lazyit API.
 *
 * Base URL comes from NEXT_PUBLIC_API_URL (see .env.example). The API is
 * currently open / unauthenticated and intended for local dev only — see
 * ADR-0016 (auth is deferred to an external IdP). Until then, the dev "acting
 * user" (ADR-0022) is attached as `X-User-Id` on every request when set.
 */

import { getActingUserId } from "./acting-user";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
}

/**
 * Fetch `path` (relative to the API base URL) and return the parsed JSON body
 * typed as `T`. Throws `ApiError` on non-2xx responses.
 */
export async function apiFetch<T>(
  path: string,
  { body, headers, ...init }: ApiFetchOptions = {},
): Promise<T> {
  // FormData (file uploads) must be sent as-is so the browser sets the
  // multipart boundary; only plain values are JSON-serialized.
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const actingUserId = getActingUserId();

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(body !== undefined && !isFormData
        ? { "Content-Type": "application/json" }
        : {}),
      ...(actingUserId ? { "X-User-Id": actingUserId } : {}),
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
