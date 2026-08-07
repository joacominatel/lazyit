/**
 * The ADR-0093 §7 duplicate remediation, as a two-step the UI sequences (issue #1202).
 *
 * §7 authorises the UI to "sequence those two existing calls behind one button" while the API keeps
 * its #1117 re-point 400 intact: `PATCH { assetId: null }` (the auto-created row carries the marker,
 * so it is soft-deleted) and then `PATCH { assetId: <the curated one> }`.
 *
 * **The two PATCHes are not atomic, and the failure between them is the dangerous state.** After
 * step 1 lands, the auto-created Asset is already archived AND `resolveDuplicateAssetSuspicion`
 * returns null for a node with no `assetId` — so the hint that named the curated Asset erases itself.
 * If step 2 then fails and the UI answers with a bare toast, the operator is left with a node linked
 * to nothing, an archived row, and no on-screen pointer to what they were relinking to. The loop
 * closes worse than it opened.
 *
 * So the progress is modelled explicitly rather than left implicit in try/catch flow, and these tests
 * pin the two questions the dialog has to answer at every point: what runs next, and has anything
 * irreversible already happened.
 */
import { describe, expect, test } from "bun:test";
import {
  relinkAssetArchived,
  relinkNextStep,
  type RelinkProgress,
} from "./relink-sequence";

const ALL: RelinkProgress[] = ["not-started", "detached", "linked"];

describe("relinkNextStep", () => {
  test("nothing done yet → detach first (§7 step 1)", () => {
    expect(relinkNextStep("not-started")).toBe("detach");
  });

  test("detached → link the curated Asset (§7 step 2)", () => {
    expect(relinkNextStep("detached")).toBe("link");
  });

  test("linked → nothing left to do", () => {
    expect(relinkNextStep("linked")).toBe(null);
  });

  test("never re-runs a step that already landed — a retry resumes, it does not restart", () => {
    // Re-issuing the detach after step 1 would be a no-op at best; re-issuing it after step 2 would
    // archive the CURATED row the operator just linked. The sequence only ever moves forward.
    expect(relinkNextStep("detached")).not.toBe("detach");
    expect(relinkNextStep("linked")).not.toBe("detach");
  });
});

describe("relinkAssetArchived", () => {
  test("false before the detach — nothing irreversible has happened yet", () => {
    expect(relinkAssetArchived("not-started")).toBe(false);
  });

  test("TRUE the moment the detach lands — this is what the retry copy must say", () => {
    // The auto-created row is archived from here on, whether or not step 2 ever succeeds.
    expect(relinkAssetArchived("detached")).toBe(true);
    expect(relinkAssetArchived("linked")).toBe(true);
  });

  test("archived implies the detach is behind us — the two answers can never disagree", () => {
    for (const progress of ALL) {
      if (relinkAssetArchived(progress)) {
        expect(relinkNextStep(progress)).not.toBe("detach");
      }
    }
  });
});
