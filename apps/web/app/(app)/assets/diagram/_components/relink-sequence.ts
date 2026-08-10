/**
 * The ADR-0093 §7 duplicate remediation as a resumable two-step (issue #1202).
 *
 * §7 is explicit that the remedy is the EXISTING two-step and that the UI may "sequence those two
 * existing calls behind one button; the API keeps its rule and its error message intact". So this is
 * not a new endpoint and deliberately not a merge — ADR-0093 §8.5 forbids machine-merging two
 * inventory rows, and no asset-merge endpoint exists in the repo. It is the same
 * `PATCH { assetId: null }` then `PATCH { assetId: <curated> }` an operator could type by hand,
 * driven from the notice that already names the curated Asset.
 *
 * **Why the progress is a value and not just control flow.** The two PATCHes are not atomic, and the
 * gap between them is genuinely lossy:
 *
 * 1. Step 1 soft-deletes the auto-created Asset (it carries the marker). That is irreversible from
 *    this screen — `POST /assets/:id/restore` costs `asset:delete` and the archived slice is
 *    admin-only, so the operator standing here may not be able to undo it.
 * 2. Step 1 ALSO erases the hint: `resolveDuplicateAssetSuspicion` returns null for a node carrying
 *    no `assetId`, so the only on-screen pointer to the curated Asset disappears the instant the
 *    detach lands. (The caller captures the peer id BEFORE step 1 for exactly this reason.)
 *
 * A step-2 failure therefore must not collapse into a bare toast: the dialog stays open, says plainly
 * that the asset was archived, and offers a retry that RESUMES at step 2 rather than restarting.
 * Restarting would re-issue the detach against the node's new state — which, once step 2 had landed,
 * would archive the curated row the operator was rescuing.
 *
 * Pure and framework-free so `bun test` can reach it (ADR-0012 — apps/web has no component harness).
 */

/** How far the §7 sequence has got. Only ever moves forward. */
export type RelinkProgress = "not-started" | "detached" | "linked";

/** The call still owed, or `null` when the sequence is complete. */
export type RelinkStep = "detach" | "link";

/**
 * What to run next. A retry after a failure passes the progress it reached, so the sequence resumes
 * instead of replaying a landed step.
 */
export function relinkNextStep(progress: RelinkProgress): RelinkStep | null {
  if (progress === "not-started") return "detach";
  if (progress === "detached") return "link";
  return null;
}

/**
 * Has the auto-created Asset already been archived? True from the moment the detach lands — the fact
 * the recovery copy must state, because it is the part the operator cannot take back from here.
 */
export function relinkAssetArchived(progress: RelinkProgress): boolean {
  return progress !== "not-started";
}
