/**
 * Minimal semver parse + compare (ADR-0084 update check) — a PURE, framework-agnostic util shared by
 * `api` (the update-check sweeper's "N behind" math) and `web` (rendering the same comparison). It is
 * DELIBERATELY tiny: lazyit tags are `vMAJOR.MINOR.PATCH` (ADR-0083) — a clean release reads `v1.4.2`,
 * an off-tag rebuild reads the honest `git describe` form `v1.4.2-3-gabc1234`. We only ever need to
 * order those three numeric fields, so we parse the `X.Y.Z` core and IGNORE any pre-release / build /
 * describe suffix. No dependency (there is no `semver` package in the tree, and we don't want one for
 * three integers).
 *
 * ponytail: this compares only major.minor.patch. Pre-release ordering (`-rc.1` < release) is NOT
 * modelled — lazyit does not ship pre-release tags as "latest" (ADR-0083 releases are the master
 * promotion), and the check drops GitHub pre-releases/drafts before it ever gets here. The ceiling: if
 * lazyit ever starts publishing ordered pre-releases as releases, this needs pre-release precedence.
 */

/** The parsed numeric core of a semver tag. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a tag into its numeric `{major, minor, patch}` core, or `null` when it isn't a recognizable
 * `vX.Y.Z`. Tolerant of a leading `v`/`V` and of anything after the patch (a `-3-gabc1234` describe
 * tail, a `-rc.1` pre-release, `+build` metadata) — all ignored. `"dev"` / `"unknown"` / `""` → null
 * (the native-dev fallbacks), so the caller treats an unparseable running version as "can't compare".
 */
export function parseSemver(tag: string | null | undefined): Semver | null {
  if (!tag) return null;
  // Strip a leading v/V, then match the leading numeric X.Y.Z; ignore any suffix (- or + or describe).
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Order two parsed semvers: negative if `a < b`, zero if equal, positive if `a > b`. Pure numeric
 * major→minor→patch comparison.
 */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * True when `candidate` is a STRICTLY newer release than `current`. Either side unparseable ⇒ false
 * (fail-soft: we never claim an update when we can't reliably compare — "couldn't parse" is never
 * "behind", mirroring the check's "couldn't check is never up to date" posture, ADR-0084 §1).
 */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  return compareSemver(c, cur) > 0;
}

/**
 * How many of `releaseTags` are strictly newer than `current` — the "N versions behind" figure
 * (ADR-0084). An unparseable `current` (native dev, an odd tag) ⇒ 0 (we cannot honestly count, so we
 * report "not behind" rather than alarm). Unparseable entries in `releaseTags` are ignored.
 */
export function countVersionsBehind(
  current: string | null | undefined,
  releaseTags: readonly string[],
): number {
  const cur = parseSemver(current);
  if (!cur) return 0;
  let behind = 0;
  for (const tag of releaseTags) {
    const t = parseSemver(tag);
    if (t && compareSemver(t, cur) > 0) behind += 1;
  }
  return behind;
}

/**
 * The single newest tag among `tags` (highest semver), or `null` when none parse. Ties (same X.Y.Z
 * from different describe forms) resolve to the first seen — irrelevant for ordering.
 */
export function maxVersion(tags: readonly string[]): string | null {
  let bestTag: string | null = null;
  let best: Semver | null = null;
  for (const tag of tags) {
    const t = parseSemver(tag);
    if (t && (best === null || compareSemver(t, best) > 0)) {
      best = t;
      bestTag = tag;
    }
  }
  return bestTag;
}
