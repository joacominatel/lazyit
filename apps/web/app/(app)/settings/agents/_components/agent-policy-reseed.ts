/**
 * What the policy editor does when `GET /infra/agent-policy` hands it a generation it has not seeded
 * its form from (#1174).
 *
 * The editor derives its fields from the persisted policy and re-seeds whenever the generation it
 * holds stops matching `data.revision`, so the form can never drift from what the server stores.
 * The catch is that `AgentPolicyService.bumpRevision` fires on EVERY policy write at EVERY scope —
 * the instance default, a service account's layer, one node's layer — so a write this operator did
 * not make moves that number too. Re-seeding on it unconditionally overwrote an in-progress edit,
 * and now that the action bar carries an "Unsaved changes" badge and a Discard button, it would
 * clear those as well: the page would assert an edit existed and then quietly retract it.
 *
 * Three outcomes, and the whole rule is which of them a foreign write gets:
 *
 *  - `idle` — this is the generation already on screen. Nothing to do.
 *  - `seed` — take the server's values. Either nothing is at stake (the form is clean) or the change
 *    is this editor's own save, which is precisely what re-seeding exists for.
 *  - `conflict` — a write from somewhere else against a DIRTY form. KEEP the edit and say so; the
 *    operator reloads deliberately or saves over it. Never a silent overwrite.
 *
 * `savedRevision` is the revision this editor's own last successful PUT returned, and is the only
 * evidence available that separates "I just saved" from "someone else wrote" — the read carries no
 * author. It is deliberately compared for EQUALITY, not `<=`: a revision past our own last save is
 * somebody else's, even though ours came first.
 *
 * This does not make the write itself safe. `PUT /infra/agent-policy` still replaces the whole
 * instance layer and the last writer still wins; what this buys is that the losing edit is never
 * discarded without the operator seeing it.
 */
export type ReseedAction = "idle" | "seed" | "conflict";

export function reseedAction(input: {
  /** The revision the query currently holds. */
  incomingRevision: number;
  /** The revision the form was last seeded from, or `null` before the first load. */
  seededRevision: number | null;
  /** Whether the form differs from its seed — i.e. whether an edit would be lost. */
  dirty: boolean;
  /** The revision this editor's own last successful save returned, if it has saved. */
  savedRevision: number | undefined;
}): ReseedAction {
  if (input.seededRevision === input.incomingRevision) return "idle";
  if (!input.dirty) return "seed";
  if (input.savedRevision === input.incomingRevision) return "seed";
  return "conflict";
}
