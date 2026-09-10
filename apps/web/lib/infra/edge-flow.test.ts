/**
 * The rules that decide when a topology edge moves (issue #1295).
 *
 * The effect is decorative, which is exactly why its gate is pinned rather than trusted: an ornament
 * that quietly starts reading as a liveness signal is a lie an operator can act on during an
 * incident. Three properties are asserted here —
 *
 *  1. **Only a POSITIVE offline fact stops a line.** `UNKNOWN` flows. A hand-built map — every node
 *     of which defaults to `UNKNOWN` — would be entirely static under a strict-ONLINE gate, and
 *     "static" is indistinguishable from "broken" for a purely visual feature.
 *  2. **Either endpoint offline is enough.** Both, source-only, target-only.
 *  3. **The board-wide cutoff is absolute.** Over it nothing animates, because every animated path
 *     repaints on the same main thread that handles panning and dragging.
 */
import { describe, expect, test } from "bun:test";
import {
  EDGE_FLOW_MAX_EDGES,
  edgeFlowEnabled,
  edgeFlows,
} from "./edge-flow";

describe("edgeFlows — the gate is NOT-OFFLINE, deliberately not ONLINE", () => {
  test("two online endpoints flow", () => {
    expect(edgeFlows("ONLINE", "ONLINE")).toBe(true);
  });

  test("UNKNOWN flows — a hand-built map must not sit completely still", () => {
    // `InfraNode.status` defaults to UNKNOWN for every node added by hand, so this case is the
    // majority of the board on an estate that runs no reporting agents at all.
    expect(edgeFlows("UNKNOWN", "UNKNOWN")).toBe(true);
    expect(edgeFlows("UNKNOWN", "ONLINE")).toBe(true);
    expect(edgeFlows("ONLINE", "UNKNOWN")).toBe(true);
  });

  test("one OFFLINE endpoint is enough to still the line, from either end", () => {
    expect(edgeFlows("OFFLINE", "ONLINE")).toBe(false);
    expect(edgeFlows("ONLINE", "OFFLINE")).toBe(false);
    expect(edgeFlows("OFFLINE", "UNKNOWN")).toBe(false);
    expect(edgeFlows("UNKNOWN", "OFFLINE")).toBe(false);
    expect(edgeFlows("OFFLINE", "OFFLINE")).toBe(false);
  });

  test("a missing status is not an offline fact — it flows rather than throwing", () => {
    // `edgesBetweenVisible` already guarantees both endpoints are on the board; this is the total
    // fallback, and it errs toward the ornament being on, which costs nothing.
    expect(edgeFlows(undefined, "ONLINE")).toBe(true);
    expect(edgeFlows(undefined, undefined)).toBe(true);
    expect(edgeFlows(undefined, "OFFLINE")).toBe(false);
  });
});

describe("edgeFlowEnabled — the board-wide cutoff", () => {
  test("an empty or small board animates", () => {
    expect(edgeFlowEnabled(0)).toBe(true);
    expect(edgeFlowEnabled(1)).toBe(true);
    // ADR-0093's reference estate (~245 hosts and their links) stays well inside the cutoff.
    expect(edgeFlowEnabled(400)).toBe(true);
  });

  test("the cutoff itself still animates; one edge more does not", () => {
    expect(edgeFlowEnabled(EDGE_FLOW_MAX_EDGES)).toBe(true);
    expect(edgeFlowEnabled(EDGE_FLOW_MAX_EDGES + 1)).toBe(false);
  });

  test("a board near the server's own edge ceiling never animates", () => {
    // `INFRA_GRAPH_EDGES_MAX` is 10_000 — an order of magnitude above the cutoff, on purpose.
    expect(edgeFlowEnabled(10_000)).toBe(false);
  });
});

describe("the effect is CSS, so reduced motion is inherited and not re-implemented", () => {
  /**
   * The one thing this module cannot assert about itself: nothing here reads
   * `prefers-reduced-motion`, and that is correct — the animation is a CSS keyframe, and
   * `globals.css` carries a single consolidated `@media (prefers-reduced-motion: reduce)` block that
   * collapses every animation on the page. This test reads the stylesheet because the property being
   * protected is a COMPOSITION: the moment someone reaches for SVG SMIL (`<animate>`, which that
   * media query does not reach) or an inline duration, the freeze silently stops applying to this
   * edge and nobody notices, because the reader who needs it is not the one reviewing the diff.
   */
  const css = () =>
    Bun.file(new URL("../../app/globals.css", import.meta.url)).text();

  test("the packet flow is a keyframe animation, reachable by the global freeze", async () => {
    const source = await css();
    expect(source).toContain("@keyframes infra-edge-packets");
    expect(source).toContain("animation: infra-edge-packets");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("the canvas animates no edge through SMIL", async () => {
    const edge = await Bun.file(
      new URL(
        "../../app/(app)/assets/diagram/_components/infra-edge.tsx",
        import.meta.url,
      ),
    ).text();
    expect(edge).not.toContain("<animate");
    expect(edge).not.toContain("animateMotion");
    // And the base path keeps the per-kind dasharray it was handed, untouched: the decoration rides
    // its OWN dash, so ADR-0070's colour-blind-safe line-style encoder cannot be flattened by it.
    expect(edge).toContain('strokeDasharray="2 14"');
    expect(edge).toContain("infra-edge-packet");
  });
});
