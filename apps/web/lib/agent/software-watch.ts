import {
  CreateSoftwareWatchSchema,
  normalizeSoftwareName,
  SOFTWARE_WATCH_LIMIT,
  type SoftwareWatch,
  type SoftwareWatchDistribution,
  type SoftwareWatchPresence,
} from "@lazyit/shared";

/**
 * The pure rules behind the software watchlist on Topology › Agents (#1684, epic #1146 item 4):
 * which of the fleet view's two sections is showing, what a drill-in bucket asks the API for, how a
 * name the operator types is judged before it is sent, and how the presence bar is drawn.
 *
 * DISTRIBUTION ONLY (CEO decision Q12 on #1146). Nothing here compares, sorts or ranks versions: the
 * buckets arrive from the API already ordered by host count (`summarizeSoftwareWatch`), and this
 * module passes that order through untouched. A version is an opaque string that gets counted.
 *
 * `software-watch.test.ts` holds these. Two of them exist because of a specific way the screen could
 * lie: drawing UNKNOWN as if it were MISSING (an operator who turned software collection off would see
 * every watched package "missing" on every host), and sending a drill-in for the "no version" bucket
 * that the API would read as "no filter at all".
 */

// ── The two sections of the Agents view ───────────────────────────────────────────────────────────

/**
 * The Agents view's two sections. `agents` is the version/liveness fleet view (ADR-0094 §4) and the
 * default; `software` is the watchlist. A section of the existing view rather than a fourth Topology
 * tab: both answer a fleet-wide question over the same agent-reported hosts.
 */
export const FLEET_SECTIONS = ["agents", "software"] as const;
export type FleetSection = (typeof FLEET_SECTIONS)[number];

/** The URL param the section lives in. Named so it cannot collide with `view`, `agents` or `q`. */
export const FLEET_SECTION_PARAM = "fleet";

/** Read `?fleet=`. Total and biased toward the default: anything unrecognised is the agents list. */
export function fleetSectionFromParam(raw: string | null | undefined): FleetSection {
  return raw === "software" ? "software" : "agents";
}

/** What to write into `?fleet=` — `undefined` (drop the param) for the default section. */
export function fleetSectionParam(section: FleetSection): string | undefined {
  return section === "agents" ? undefined : section;
}

// ── The drill-in ──────────────────────────────────────────────────────────────────────────────────

/**
 * One drill-in target behind a watch: a whole presence (the hosts that have it, the hosts MISSING it,
 * the hosts UNKNOWN for it), or one version bucket. `version: null` is the bucket of hosts that list
 * the package without a version.
 */
export type SoftwareWatchBucket =
  | { kind: "presence"; presence: SoftwareWatchPresence }
  | { kind: "version"; version: string | null };

/** The page size the drill-in asks for. The API's default, stated so the request is explicit. */
export const SOFTWARE_WATCH_HOSTS_PAGE = 50;

/**
 * The query string for one drill-in page (`GET /infra/software-watches/:id/hosts`).
 *
 * A version bucket sends `version` ALONE: it implies INSTALLED server-side, and pairing it with any
 * other presence is a 400. The null bucket is sent as an EMPTY value (`version=`) — that is the API's
 * spelling of "listed without a version", and leaving the key out instead would silently widen the
 * drill-in to every host.
 */
export function softwareWatchHostsQuery(
  bucket: SoftwareWatchBucket,
  offset: number,
  limit: number = SOFTWARE_WATCH_HOSTS_PAGE,
): string {
  const qs = new URLSearchParams();
  if (bucket.kind === "presence") {
    qs.set("presence", bucket.presence);
  } else {
    qs.set("version", bucket.version ?? "");
  }
  qs.set("limit", String(limit));
  qs.set("offset", String(Math.max(0, Math.trunc(offset))));
  return qs.toString();
}

/** A stable key for a bucket — React keys, query keys, and "is this the open one". */
export function softwareWatchBucketKey(bucket: SoftwareWatchBucket): string {
  if (bucket.kind === "presence") return `presence:${bucket.presence}`;
  return bucket.version === null ? "version:null" : `version=${bucket.version}`;
}

/**
 * How many hosts a bucket holds, from the distribution already on screen — the drill-in's heading
 * before its first page arrives. A version bucket that is no longer in the distribution (a host
 * re-reported in between) reads 0, never an error.
 */
export function softwareWatchBucketCount(
  distribution: SoftwareWatchDistribution,
  bucket: SoftwareWatchBucket,
): number {
  if (bucket.kind === "presence") {
    if (bucket.presence === "INSTALLED") return distribution.installed;
    if (bucket.presence === "MISSING") return distribution.missing;
    return distribution.unknown;
  }
  return distribution.versions.find((entry) => entry.version === bucket.version)?.hosts ?? 0;
}

// ── The presence bar ──────────────────────────────────────────────────────────────────────────────

export interface PresenceSegment {
  presence: SoftwareWatchPresence;
  hosts: number;
  /** Share of `hostsTotal`, 0–100. The three always sum to 100 when there is any host at all. */
  percent: number;
}

/**
 * The three presences as segments of one bar. They partition the population
 * (`installed + missing + unknown = hostsTotal`), so a stacked bar is honest here — unlike the version
 * buckets, which can overlap (a host with two kernels counts in both) and are therefore listed, never
 * stacked. UNKNOWN is always its own segment: folding it into MISSING is the lie this feature exists
 * not to tell. An empty population returns no segments rather than dividing by zero.
 */
export function softwareWatchPresenceSegments(
  distribution: SoftwareWatchDistribution,
): PresenceSegment[] {
  const total = distribution.hostsTotal;
  if (total <= 0) return [];
  const raw: [SoftwareWatchPresence, number][] = [
    ["INSTALLED", distribution.installed],
    ["MISSING", distribution.missing],
    ["UNKNOWN", distribution.unknown],
  ];
  return raw
    .filter(([, hosts]) => hosts > 0)
    .map(([presence, hosts]) => ({ presence, hosts, percent: (hosts / total) * 100 }));
}

/**
 * The version buckets to list, in the order the API sent them (host count first) — never re-sorted,
 * because any re-sort here would be read as a version order. `limit` keeps a watch with dozens of
 * versions to a glance; `hidden` is how many were left out so the UI can offer the rest.
 */
export function softwareWatchVisibleVersions(
  distribution: SoftwareWatchDistribution,
  limit: number,
): { shown: SoftwareWatchDistribution["versions"]; hidden: number } {
  const shown = distribution.versions.slice(0, Math.max(0, limit));
  return { shown, hidden: distribution.versions.length - shown.length };
}

// ── Adding a watch ────────────────────────────────────────────────────────────────────────────────

/**
 * What the add form says about the name typed so far, decided before anything is sent.
 *
 *   - `empty`     — nothing (or only whitespace) typed; the button is disabled, no error shown.
 *   - `invalid`   — the shared write schema rejects it (too long).
 *   - `duplicate` — a live watch already holds the same NORMALIZED name. The API would 409; saying
 *     so inline is kinder, and the 409 stays the real gate for a race.
 *   - `limit`     — the instance already holds {@link SOFTWARE_WATCH_LIMIT} watches.
 *   - `ok`        — sendable. `normalized` is what will be stored, so the form can show it when it
 *     differs from what was typed (`" OpenSSL "` is stored as `openssl`).
 */
export type WatchNameVerdict =
  | { state: "empty" }
  | { state: "invalid" }
  | { state: "duplicate"; normalized: string }
  | { state: "limit" }
  | { state: "ok"; normalized: string };

export function judgeWatchName(
  raw: string,
  existing: readonly Pick<SoftwareWatch, "name">[],
): WatchNameVerdict {
  if (normalizeSoftwareName(raw) === "") return { state: "empty" };
  if (existing.length >= SOFTWARE_WATCH_LIMIT) return { state: "limit" };
  const parsed = CreateSoftwareWatchSchema.safeParse({ name: raw });
  if (!parsed.success) return { state: "invalid" };
  const normalized = parsed.data.name;
  // Stored names are already normalized, but normalizing again costs nothing and keeps a legacy or
  // hand-written row from slipping past the check.
  if (existing.some((watch) => normalizeSoftwareName(watch.name) === normalized)) {
    return { state: "duplicate", normalized };
  }
  return { state: "ok", normalized };
}

/** The fleet node a drill-in row links to — the same deep link the fleet and servers tables use. */
export function softwareWatchNodeHref(nodeId: string): string {
  return `/assets/diagram?view=map&node=${encodeURIComponent(nodeId)}`;
}
