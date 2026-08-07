/**
 * Which detach a click is about to run (issue #1202).
 *
 * `PATCH /infra/nodes/:id` with `assetId: null` has TWO outcomes that are not interchangeable:
 * an Asset lazyit minted itself carries `_infraAutoCreated`, so the detach **soft-deletes** it
 * (a DELETED history event, dropped from search, gone from the live inventory list); an Asset a
 * human curated carries no marker, so the detach only nulls the node's column and the row is
 * untouched. A single generic "are you sure?" over both of those is the bug #1202 is about.
 *
 * The decision is one boolean read, but it is the boolean that decides whether a confirmation says
 * *"this archives an inventory record"* or *"nothing happens to the asset"* — so it is pinned here
 * rather than left inline in JSX that `bun test` cannot reach (ADR-0012: apps/web has no component
 * harness, so the branch is extracted to be testable at all).
 *
 * The branch that a bug would make SILENT is `null`/`undefined`: an API older than #1202 omits the
 * field entirely, and a node whose Asset row vanished reports it as null. Both must resolve to the
 * DESTRUCTIVE copy — an unknown provenance is precisely the case where a dialog must not promise
 * that nothing will be deleted.
 */
import { describe, expect, test } from "bun:test";
import { detachOutcome, type DetachOutcome } from "./detach-outcome";

describe("detachOutcome", () => {
  test("`true` → archives: lazyit minted the Asset, so the detach soft-deletes it", () => {
    expect(detachOutcome(true)).toBe("archives");
  });

  test("`false` → unlinks: a curated row survives the detach intact (ADR-0093 §4)", () => {
    expect(detachOutcome(false)).toBe("unlinks");
  });

  test("`null` → archives — the FAIL-SAFE: unknown provenance never promises a survivor", () => {
    // A node whose linked Asset row is gone, or any state the server could not resolve.
    expect(detachOutcome(null)).toBe("archives");
  });

  test("`undefined` → archives — a pre-#1202 API omits the field and must not read as safe", () => {
    // The read-tolerance direction that matters: an operator on an older API still gets the
    // cautious wording, so the worst case is an over-warning, never an unannounced archive.
    expect(detachOutcome(undefined)).toBe("archives");
  });

  test("the two outcomes are DISTINCT — they can never collapse into one confirmation", () => {
    // If a refactor ever made both arms return the same token the dialog would go generic again,
    // which is exactly the defect this issue exists to fix. Pin the difference itself.
    expect(detachOutcome(true)).not.toBe(detachOutcome(false));
  });

  test("every input resolves to one of the two known tokens — no third state leaks out", () => {
    const inputs: Array<boolean | null | undefined> = [true, false, null, undefined];
    const known: DetachOutcome[] = ["archives", "unlinks"];
    for (const input of inputs) {
      expect(known).toContain(detachOutcome(input));
    }
  });

  test("only an EXPLICIT `false` is the safe arm — everything else warns", () => {
    // Stated as the invariant rather than as four cases: the safe copy is opt-in, on a positive
    // server answer, and is never reached by absence.
    const inputs: Array<boolean | null | undefined> = [true, false, null, undefined];
    const safe = inputs.filter((input) => detachOutcome(input) === "unlinks");
    expect(safe).toEqual([false]);
  });
});
