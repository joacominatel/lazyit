import type { InfraImpactNode, InfraImpactResponse } from "@lazyit/shared";

/**
 * What the on-canvas blast-radius banner has to say right now (ADR-0070 §7, issue #1182), split out
 * of the component so the three states — and the enumeration in particular — are executed by a test
 * instead of trusted to a reviewer's eye.
 *
 * The three states are not decoration:
 *
 *  - `loading` is the gap between the click and the answer. The rail had a `role="status"` skeleton
 *    here; the canvas needs one too, because on a large graph a board that has not changed yet reads
 *    as "the button didn't work", and that is how an operator ends up clicking a toggle three times.
 *  - `safe` is an EMPTY radius, which ADR-0070 §7 insists is the good news rather than an empty
 *    result — hence its own state, never `affected` with a count of zero.
 *  - `failed` is a query that came back an error. It is NOT `safe`: the rail resolved a failed
 *    impact query to `affected: []` and told the operator the node was "safe to take down", a
 *    reassurance nobody had computed. Nor is it `loading`, or the skeleton would spin forever.
 *  - `affected` carries BOTH answers, because the map and the list answer different questions.
 *    Highlighting answers *roughly how bad*; the count answers *how many*; only the enumeration
 *    answers **which ones**, in a form an operator can scan, count and copy. A dozen glowing cards
 *    read off the canvas by eye is not that.
 */
export type ImpactSummaryPlan =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "safe" }
  | {
      state: "affected";
      /** How many nodes go down with the root. Always `affected.length` — one answer, two renderings. */
      count: number;
      /** Every affected node, ordered for triage. Never a truncation of the count. */
      affected: InfraImpactNode[];
    };

/**
 * Resolve the one impact response into the banner's state.
 *
 * `undefined` means "not resolved yet" — the same signal the canvas's `inImpactMode` reads to decide
 * whether it may dim the board (#775): the query keeps its last answer cached, so anything short of
 * an actually-resolved response for THIS node has to read as in-flight.
 *
 * A response WINS over `failed`, deliberately: a background refetch that errors leaves the last good
 * radius on screen, and the last computed answer beats an error banner over a board that is still
 * highlighting it. `failed` therefore describes only the case where there is nothing to show.
 *
 * The enumeration is sorted **shallowest first, then alphabetically** — the immediate blast radius
 * before the transitive tail, which is both the order the rail's list used and the order an operator
 * triages in. The sort runs on a copy: the array belongs to the TanStack cache and is shared with the
 * canvas's own highlight set.
 */
export function planImpactSummary(
  impact: InfraImpactResponse | undefined,
  failed = false,
): ImpactSummaryPlan {
  if (impact === undefined)
    return failed ? { state: "failed" } : { state: "loading" };
  const affected = [...impact.affected].sort(
    (a, b) => a.depth - b.depth || a.label.localeCompare(b.label),
  );
  if (affected.length === 0) return { state: "safe" };
  return { state: "affected", count: affected.length, affected };
}
