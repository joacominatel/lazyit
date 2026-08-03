/**
 * The `?node=<id>` deep-link rule for the Topology screen (issue #760, corrected in #1182).
 *
 * A Table row links to `/assets/diagram?view=map&node=<id>`, and the Manual, the ADR and
 * `diagramHref`'s own comment all promise that the row lands on the Map with that node selected and
 * its detail open. That promise was only kept for a FULL page load: `DiagramView` seeded its
 * selection from a `useState` initializer, which runs once per mount, and an in-app row click is a
 * client-side navigation to the same route with different search params — the component never
 * remounts, so the initializer never re-runs and the operator landed on the canvas with nothing
 * selected. A row that navigates to the map without selecting the node you clicked is worse than no
 * link at all, so the rule is: apply the param whenever it CHANGES, not only on mount.
 *
 * "Whenever it changes" is not "on every render". After the URL has landed the operator owns the
 * selection — re-applying an unchanged param would drag them back to the deep-linked node (and
 * re-open a detail they just closed) on any unrelated re-render. So the caller remembers what it has
 * already applied and this decides, from that pair, whether there is anything new to open.
 *
 * @param applied The `?node=` value already applied to the selection (null when none has been).
 * @param param   The `?node=` value the URL carries now (null when the URL names no node).
 * @returns The node id to select + open, or null when there is nothing new to apply.
 */
export function nodeToOpenFromUrl(
  applied: string | null,
  param: string | null,
): string | null {
  if (param === null) return null;
  if (param === applied) return null;
  return param;
}
