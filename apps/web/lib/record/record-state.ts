import type { AccessGrant, AssetAssignment } from "@lazyit/shared";

/**
 * Pure derivations behind the record pages (`assets/[id]`, `users/[id]` — issue #1525): the expiry
 * state a key fact or an attention item renders, the tab a `?tab=` value resolves to, the order the
 * access list sorts in, and the merged closed-record history. Kept free of React so the rules are
 * unit-tested and the server render and the hydrating client agree for the same `now`.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * The "expiring soon" look-ahead for an access grant on the user page. Mirrors the dashboard's default
 * `expiringWithinDays` (30) so "expires soon" means the same thing on the person and on the dashboard
 * tile. Warranties use the shared `WARRANTY_EXPIRING_WITHIN_DAYS` (90) instead.
 */
export const GRANT_EXPIRING_WITHIN_DAYS = 30;

export type ExpiryState =
  | { kind: "none" }
  | { kind: "active"; days: number }
  | { kind: "expiring"; days: number }
  | { kind: "expired"; days: number };

/**
 * Where an end date sits relative to `now`, with the same window the API uses for the warranty filter
 * (#955): `expiring` is `now < end <= now + windowDays`, `expired` is `end <= now`. `days` is whole
 * days left (rounded up, so "ends later today" reads as 1) or whole days since it lapsed (rounded down,
 * so "lapsed an hour ago" reads as 0). A missing or unparseable date is `none` — tolerant of legacy rows.
 */
export function expiryState(
  iso: string | null | undefined,
  now: number,
  windowDays: number,
): ExpiryState {
  if (!iso) return { kind: "none" };
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return { kind: "none" };
  if (end <= now) {
    return { kind: "expired", days: Math.floor((now - end) / MS_PER_DAY) };
  }
  const days = Math.ceil((end - now) / MS_PER_DAY);
  return end - now <= windowDays * MS_PER_DAY
    ? { kind: "expiring", days }
    : { kind: "active", days };
}

/**
 * The tab a `?tab=` value selects: the value itself when it names a tab this viewer can see, else the
 * fallback. A hidden tab (no permission) or a stale value from an old link degrades to the default
 * instead of rendering an empty pane.
 */
export function resolveRecordTab<T extends string>(
  value: string | null | undefined,
  tabs: readonly T[],
  fallback: T,
): T {
  return value != null && (tabs as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

type GrantTiming = Pick<AccessGrant, "id" | "grantedAt" | "expiresAt">;

/**
 * Active grants ordered by what needs attention first: expired (oldest lapse first), then expiring
 * soon (nearest first), then the rest newest-granted first. Returns a new array.
 */
export function sortGrantsByUrgency<G extends GrantTiming>(
  grants: readonly G[],
  now: number,
): G[] {
  const rank = (grant: G) => {
    const state = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
    return state.kind === "expired" ? 0 : state.kind === "expiring" ? 1 : 2;
  };
  const time = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
  return [...grants].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) < 2) return time(a.expiresAt) - time(b.expiresAt);
    return time(b.grantedAt) - time(a.grantedAt) || a.id.localeCompare(b.id);
  });
}

export type ClosedRecord =
  | {
      kind: "asset";
      id: string;
      refId: string;
      start: string;
      end: string;
      notes: string | null;
    }
  | {
      kind: "access";
      id: string;
      refId: string;
      start: string;
      end: string;
      accessLevel: string | null;
    };

/**
 * A person's closed records — released assignments and revoked grants — as one list, most recently
 * closed first. Open rows (no `releasedAt` / `revokedAt`) are left out: they live in the Assets and
 * Access tabs.
 */
export function closedRecordHistory(
  assignments: readonly AssetAssignment[],
  grants: readonly AccessGrant[],
): ClosedRecord[] {
  const records: ClosedRecord[] = [];
  for (const a of assignments) {
    if (a.releasedAt === null) continue;
    records.push({
      kind: "asset",
      id: a.id,
      refId: a.assetId,
      start: a.assignedAt,
      end: a.releasedAt,
      notes: a.notes,
    });
  }
  for (const g of grants) {
    if (g.revokedAt === null) continue;
    records.push({
      kind: "access",
      id: g.id,
      refId: g.applicationId,
      start: g.grantedAt,
      end: g.revokedAt,
      accessLevel: g.accessLevel,
    });
  }
  return records.sort(
    (a, b) =>
      new Date(b.end).getTime() - new Date(a.end).getTime() ||
      a.id.localeCompare(b.id),
  );
}
