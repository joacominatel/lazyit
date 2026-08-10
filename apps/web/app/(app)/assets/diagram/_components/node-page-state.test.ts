/**
 * The one rule the #1152 read split exists to enforce, asserted rather than described:
 *
 *   **no consumer may render a truncated view that looks complete.**
 *
 * Both node surfaces that can hold a subset are guarded here, and both failures they guard against
 * are silent ones — the kind nobody files a bug for, because the screen looks fine:
 *
 *  1. **A short map reads as a complete map.** `GET /infra/graph/nodes` is bounded at
 *     `INFRA_GRAPH_NODES_MAX`. A node that falls outside the cap takes its drawn edges and impact
 *     highlight with it. The impact API's count/list stay authoritative, but the banner naming both
 *     graph numbers is the only cue that the picture cannot show every affected node.
 *  2. **A batched tray reads as a finished tray.** One ADR-0095 hypervisor can enrol up to 500 guests
 *     in a single report, so a 200-row page of proposals is routine. Confirming everything on screen
 *     and seeing the tray empty must not mean "done" when 231 are still queued.
 *
 * The boundaries are where this gets decided, so they are what is tested hardest: an exact fit
 * (`total === limit`, `truncated: false`) must stay SILENT, or the notice becomes noise an operator
 * learns to ignore — at which point the real one no longer works either.
 */
import {
  INFRA_GRAPH_EDGES_MAX,
  INFRA_GRAPH_NODES_MAX,
  MAX_PAGE_LIMIT,
} from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import {
  graphEdgeLoadState,
  graphTruncationNotice,
  pendingBatchNotice,
} from "./node-page-state";

describe("graphTruncationNotice (#1152)", () => {
  test("a complete map says nothing", () => {
    expect(
      graphTruncationNotice({ total: 312, limit: INFRA_GRAPH_NODES_MAX, truncated: false }),
    ).toBeNull();
  });

  test("an EXACT fit is complete, not truncated — total === limit stays silent", () => {
    expect(
      graphTruncationNotice({
        total: INFRA_GRAPH_NODES_MAX,
        limit: INFRA_GRAPH_NODES_MAX,
        truncated: false,
      }),
    ).toBeNull();
  });

  test("an empty estate says nothing", () => {
    expect(
      graphTruncationNotice({ total: 0, limit: INFRA_GRAPH_NODES_MAX, truncated: false }),
    ).toBeNull();
  });

  test("a truncated map names BOTH numbers, so the sentence can state what is missing", () => {
    const notice = graphTruncationNotice({
      total: 2431,
      limit: INFRA_GRAPH_NODES_MAX,
      truncated: true,
    });
    expect(notice).toEqual({ shown: INFRA_GRAPH_NODES_MAX, total: 2431 });
  });

  test("one node over the cap is still a notice — the threshold is the flag, not a margin", () => {
    expect(
      graphTruncationNotice({
        total: INFRA_GRAPH_NODES_MAX + 1,
        limit: INFRA_GRAPH_NODES_MAX,
        truncated: true,
      }),
    ).toEqual({ shown: INFRA_GRAPH_NODES_MAX, total: INFRA_GRAPH_NODES_MAX + 1 });
  });

  test("the SERVER's flag decides, never our own arithmetic", () => {
    // The server is the only thing that knows whether the cap bit. If it says truncated, we say so
    // even when the two counts happen to agree; if it says complete, we stay quiet even when they
    // do not (a count and a page read a moment apart, mid-report).
    expect(
      graphTruncationNotice({ total: 2000, limit: 2000, truncated: true }),
    ).toEqual({ shown: 2000, total: 2000 });
    expect(
      graphTruncationNotice({ total: 2431, limit: 2000, truncated: false }),
    ).toBeNull();
  });
});

describe("pendingBatchNotice (#1152)", () => {
  test("a tray holding everything says nothing", () => {
    expect(pendingBatchNotice({ total: 12, shown: 12 })).toBeNull();
  });

  test("an empty tray says nothing", () => {
    expect(pendingBatchNotice({ total: 0, shown: 0 })).toBeNull();
  });

  test("a full page that is also the whole set stays silent", () => {
    expect(
      pendingBatchNotice({ total: MAX_PAGE_LIMIT, shown: MAX_PAGE_LIMIT }),
    ).toBeNull();
  });

  test("a hypervisor enrolment names both numbers — 431 pending, 200 on screen", () => {
    expect(pendingBatchNotice({ total: 431, shown: MAX_PAGE_LIMIT })).toEqual({
      shown: MAX_PAGE_LIMIT,
      total: 431,
    });
  });

  test("one row held back is still a notice", () => {
    expect(
      pendingBatchNotice({ total: MAX_PAGE_LIMIT + 1, shown: MAX_PAGE_LIMIT }),
    ).toEqual({ shown: MAX_PAGE_LIMIT, total: MAX_PAGE_LIMIT + 1 });
  });

  test("shown > total is a torn read, not a negative remainder — stay silent", () => {
    // `total` is counted and `items` are selected in the same request, but a consumer can hold a
    // previous page (keepPreviousData) beside a fresher count while proposals are being confirmed.
    // Announcing "showing 200 of 3" would be worse than saying nothing for one poll interval.
    expect(pendingBatchNotice({ total: 3, shown: 200 })).toBeNull();
  });
});

describe("graphEdgeLoadState", () => {
  const edges = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));

  test("a complete edge set has no warning and may prove an empty map", () => {
    expect(
      graphEdgeLoadState(
        { items: edges(12), total: 12, truncated: false },
        false,
      ),
    ).toEqual({ truncation: null, failure: null, canShowEmpty: true });
  });

  test("an exact-cap fit with truncated=false has no warning", () => {
    const state = graphEdgeLoadState(
      {
        items: edges(INFRA_GRAPH_EDGES_MAX),
        total: INFRA_GRAPH_EDGES_MAX,
        truncated: false,
      },
      false,
    );
    expect(state.truncation).toBeNull();
    expect(state.canShowEmpty).toBe(true);
  });

  test("one edge over the cap names the shown and total counts", () => {
    const state = graphEdgeLoadState(
      {
        items: edges(INFRA_GRAPH_EDGES_MAX),
        total: INFRA_GRAPH_EDGES_MAX + 1,
        truncated: true,
      },
      false,
    );
    expect(state.truncation).toEqual({
      shown: INFRA_GRAPH_EDGES_MAX,
      total: INFRA_GRAPH_EDGES_MAX + 1,
    });
    expect(state.canShowEmpty).toBe(false);
  });

  test("the server truncation flag is authoritative", () => {
    expect(
      graphEdgeLoadState(
        { items: edges(2), total: 2, truncated: true },
        false,
      ).truncation,
    ).toEqual({ shown: 2, total: 2 });
    expect(
      graphEdgeLoadState(
        { items: edges(2), total: 20, truncated: false },
        false,
      ).truncation,
    ).toBeNull();
  });

  test("an edge failure is retryable and never an empty or complete map", () => {
    expect(graphEdgeLoadState(undefined, true)).toEqual({
      truncation: null,
      failure: { incomplete: true, retryable: true },
      canShowEmpty: false,
    });
  });
});
