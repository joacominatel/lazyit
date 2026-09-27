import type { Session } from "next-auth";

/**
 * Whether an Auth.js `auth()` result is a real signed-in session, not just a truthy value (#1399,
 * SEC-079). Every server-side route guard uses this instead of `if (!session)`.
 *
 * Through `next-auth@5.0.0-beta.31`, a server-side configuration error (a missing `AUTH_SECRET`, an
 * untrusted host) made `auth()` return the session endpoint's error body,
 * `{ message: "There was a problem with the server configuration…" }`. That object is truthy, so an
 * existence check let every visitor through (GHSA-8fpg-xm3f-6cx3). beta.32 returns `null` on a non-OK
 * response. This guard also requires the `user` object that only a genuine session carries, as the
 * advisory's workaround recommends. The guards then fail closed whatever the library does with an error.
 *
 * The API authorizes every request on its own Bearer, so this guard protects only the web UI. It is
 * defense in depth, not the authorization boundary.
 */
export function hasSession(
  session: Session | null | undefined,
): session is Session & { user: NonNullable<Session["user"]> } {
  const user = (session as { user?: unknown } | null | undefined)?.user;
  return typeof user === "object" && user !== null;
}
