/**
 * Which view the one Topology destination is showing (`?view`, #760 — extended by ADR-0094 §4).
 *
 * Out of the component for the same reason `endpoints.ts` is: this param decides what an operator
 * sees at all, and "an unrecognised value must not error and must not show nothing" is a rule worth
 * asserting rather than describing. It is read from the URL on every render (no local mirror), so a
 * Map⇄Table⇄Agents switch preserves every other param — the Table's filters, the Agents view's
 * filter, and a `?node=` selection.
 */

/** The three views. The Map is the default and the param is dropped when it is selected. */
export const TOPOLOGY_VIEWS = ["map", "table", "agents"] as const;
export type TopologyView = (typeof TOPOLOGY_VIEWS)[number];

/** The default. Written to the URL as an ABSENT param, which is why it is named rather than typed. */
export const DEFAULT_TOPOLOGY_VIEW: TopologyView = "map";

/**
 * Read `?view`. Total, and biased toward the Map: a typo, a tampered link or a bookmark from a
 * future release lands on the board rather than on an error or an empty screen.
 */
export function topologyViewFromParam(
  raw: string | null | undefined,
): TopologyView {
  return (TOPOLOGY_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as TopologyView)
    : DEFAULT_TOPOLOGY_VIEW;
}

/**
 * What to write into `?view` for a selected tab — `undefined` for the default, which drops the param
 * and keeps a freshly-loaded Topology URL clean (the `useListParams` convention).
 */
export function topologyViewParam(view: TopologyView): string | undefined {
  return view === DEFAULT_TOPOLOGY_VIEW ? undefined : view;
}
