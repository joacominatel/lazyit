import type { UserSession, UserSessionList } from "@lazyit/shared";

/**
 * One entry of the account hub's "Your sessions" list (#1420, ADR-0086 §9): a real session row from
 * `GET /auth/sessions`, or the single synthetic entry for THIS device when its session was opened before
 * the per-device list existed (`currentIsLegacy`) — it has no row, so it cannot be ended on its own.
 */
export type SessionListEntry =
  | { kind: "session"; session: UserSession }
  | { kind: "legacy" };

/**
 * The entries to render, this device first: the synthetic legacy entry (when the caller's own token has
 * no session row) or the `current` session, then the others in the API's most-recent-activity order.
 * Pure, so the ordering and the legacy rule are unit-tested without rendering.
 */
export function sessionListEntries(
  list: UserSessionList | undefined,
): SessionListEntry[] {
  if (!list) return [];
  const current = list.sessions.filter((s) => s.current);
  const others = list.sessions.filter((s) => !s.current);
  const head: SessionListEntry[] = list.currentIsLegacy
    ? [{ kind: "legacy" }]
    : [];
  return [
    ...head,
    ...current.map((session) => ({ kind: "session" as const, session })),
    ...others.map((session) => ({ kind: "session" as const, session })),
  ];
}

/**
 * "Chrome · macOS", just the half that parsed, or null when neither did (an unknown agent) — the caller
 * then shows its localized "Unknown browser".
 */
export function deviceLabel(
  session: Pick<UserSession, "browser" | "os">,
): string | null {
  const parts = [session.browser, session.os].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
