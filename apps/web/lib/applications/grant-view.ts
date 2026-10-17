import type { AccessGrant, Application } from "@lazyit/shared";
import {
  expiryState,
  GRANT_EXPIRING_WITHIN_DAYS,
  sortGrantsByUrgency,
} from "@/lib/record/record-state";

// The page reads every grant of the application in one unpaginated call, so the views are derived here.

export const GRANT_STATUS_FILTERS = ["active", "expiring", "revoked", "all"] as const;
export type GrantStatusFilter = (typeof GRANT_STATUS_FILTERS)[number];

export const NO_ACCESS_LEVEL = "\u0000none";

type GrantRow = Pick<
  AccessGrant,
  "id" | "userId" | "accessLevel" | "grantedAt" | "revokedAt" | "expiresAt"
>;

/** `expiring` includes grants already past their expiry: they stay active until the sweep revokes them. */
export function matchesGrantStatus(
  grant: GrantRow,
  status: GrantStatusFilter,
  now: number,
): boolean {
  switch (status) {
    case "all":
      return true;
    case "revoked":
      return grant.revokedAt !== null;
    case "active":
      return grant.revokedAt === null;
    case "expiring": {
      if (grant.revokedAt !== null) return false;
      const state = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
      return state.kind === "expiring" || state.kind === "expired";
    }
  }
}

export type GrantStatusCounts = Record<GrantStatusFilter, number>;

export function grantStatusCounts(
  grants: readonly GrantRow[],
  now: number,
): GrantStatusCounts {
  const counts: GrantStatusCounts = { active: 0, expiring: 0, revoked: 0, all: grants.length };
  for (const grant of grants) {
    if (grant.revokedAt !== null) {
      counts.revoked += 1;
      continue;
    }
    counts.active += 1;
    if (matchesGrantStatus(grant, "expiring", now)) counts.expiring += 1;
  }
  return counts;
}

export function grantExpiryCounts(
  grants: readonly GrantRow[],
  now: number,
): { expired: number; expiring: number } {
  let expired = 0;
  let expiring = 0;
  for (const grant of grants) {
    if (grant.revokedAt !== null) continue;
    const state = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
    if (state.kind === "expired") expired += 1;
    else if (state.kind === "expiring") expiring += 1;
  }
  return { expired, expiring };
}

/** Lower-case and strip accents, so "jose" finds "José". */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export interface GrantPerson {
  name: string;
  email?: string | null;
}

export interface GrantViewOptions {
  status: GrantStatusFilter;
  query: string;
  /** An access level, {@link NO_ACCESS_LEVEL}, or `null` for any level. */
  level: string | null;
  now: number;
  /** `undefined` while the person has not resolved; such a grant never matches a search. */
  personOf: (userId: string) => GrantPerson | undefined;
}

/** Active and all views sort by person, expiring ones by urgency, revoked ones newest revocation first. */
export function selectGrants<G extends GrantRow>(
  grants: readonly G[],
  { status, query, level, now, personOf }: GrantViewOptions,
): G[] {
  const needle = foldSearchText(query.trim());
  const filtered = grants.filter((grant) => {
    if (!matchesGrantStatus(grant, status, now)) return false;
    if (level !== null) {
      if (level === NO_ACCESS_LEVEL ? grant.accessLevel !== null : grant.accessLevel !== level) {
        return false;
      }
    }
    if (!needle) return true;
    const person = personOf(grant.userId);
    if (!person) return false;
    return (
      foldSearchText(person.name).includes(needle) ||
      (person.email ? foldSearchText(person.email).includes(needle) : false)
    );
  });

  if (status === "expiring") return sortGrantsByUrgency(filtered, now);
  if (status === "revoked") {
    return filtered.sort(
      (a, b) =>
        time(b.revokedAt) - time(a.revokedAt) || a.id.localeCompare(b.id),
    );
  }
  return filtered.sort((a, b) => {
    const nameA = personOf(a.userId)?.name;
    const nameB = personOf(b.userId)?.name;
    if (nameA === undefined || nameB === undefined) {
      if (nameA !== nameB) return nameA === undefined ? 1 : -1;
    } else {
      const byName = nameA.localeCompare(nameB);
      if (byName !== 0) return byName;
    }
    return (
      Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
      time(b.grantedAt) - time(a.grantedAt) ||
      a.id.localeCompare(b.id)
    );
  });
}

function time(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}

/** Distinct levels, alphabetical, with "no level" last. */
export function accessLevelOptions(
  grants: readonly GrantRow[],
): { level: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const grant of grants) {
    const key = grant.accessLevel ?? NO_ACCESS_LEVEL;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => {
      if (a.level === NO_ACCESS_LEVEL) return 1;
      if (b.level === NO_ACCESS_LEVEL) return -1;
      return a.level.localeCompare(b.level);
    });
}

export interface SeatState {
  used: number;
  /** `null` when seats are not tracked. */
  purchased: number | null;
  overBy: number;
  free: number;
  /** used / purchased for the meter; `null` when untracked or zero seats were bought. */
  fill: number | null;
}

export function seatState(
  application: Pick<Application, "seatsPurchased" | "seatsUsed">,
): SeatState {
  const used = application.seatsUsed ?? 0;
  const purchased = application.seatsPurchased ?? null;
  if (purchased === null) return { used, purchased, overBy: 0, free: 0, fill: null };
  return {
    used,
    purchased,
    overBy: Math.max(0, used - purchased),
    free: Math.max(0, purchased - used),
    fill: purchased > 0 ? used / purchased : null,
  };
}
