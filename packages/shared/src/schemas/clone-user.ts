import { z } from "zod";
import { CreateUserSchema, UserSchema } from "./user";
import { MAX_BATCH_IDS } from "./batch";

/**
 * Clone-with-chosen-actions (ADR-0058 §4) — the `POST /users/:id/clone` contract. Onboarding "a new
 * dev, same access as Ana": the SOURCE user (`:id`, must be live) is the template; the admin picks, in
 * the body, exactly which of the source's CURRENT footprint carries over to the NEW user. Single source
 * of truth for api and web.
 *
 * A clone is a CREATE with extras, never a privileged bypass:
 *   - `profile` is a normal CreateUser payload — the new user's OWN identity. The clone NEVER copies the
 *     source's email/legajo/username (those are unique) or externalId (never client-settable, SEC-006);
 *     the admin supplies the new identity here, validated exactly as `POST /users` would.
 *   - `cloneAssetAssignments` / `cloneAccessGrants` are OPT-IN id lists of the source's ACTIVE
 *     assignments / grants to mirror as NEW append-only rows for the new user (assignedAt/grantedAt =
 *     now, actor = the cloning admin). Empty/omitted ⇒ carry nothing. A soft-deleted asset behind a
 *     listed assignment is skipped and reported; the source's own rows are never touched (additive).
 *   - `fireWorkflowsOnClonedGrants` is the engine toggle (ADR-0058, the ratified safe-by-default): when
 *     FALSE (default) cloned grants are written bookkeeping-only (the after-commit ACCESS_GRANTED
 *     workflow trigger is SUPPRESSED); when TRUE each cloned grant takes the normal grant path and fires
 *     the workflow engine (provisioning the new hire externally). Either way the grant row is identical
 *     and auditable; the choice is recorded in the clone's CREATED UserHistory payload.
 */
export const CloneUserSchema = z.strictObject({
  // The new user's own identity — a full, normally-validated CreateUser payload (email/firstName/
  // lastName/role + optional legajo/username/manager). Required: a clone must mint a distinct identity.
  profile: CreateUserSchema,
  // Which of the source's ACTIVE asset assignments to mirror (by assignment id, cuid). De-duplicated &
  // bounded by MAX_BATCH_IDS — a clone can't be an unbounded write. Default [] (carry no assets).
  cloneAssetAssignments: z
    .array(z.cuid())
    .max(MAX_BATCH_IDS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "cloneAssetAssignments must be unique (no duplicates)",
    })
    .default([]),
  // Which of the source's ACTIVE access grants to mirror (by grant id, cuid). Same bounds/dedupe.
  cloneAccessGrants: z
    .array(z.cuid())
    .max(MAX_BATCH_IDS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "cloneAccessGrants must be unique (no duplicates)",
    })
    .default([]),
  // The engine toggle (ADR-0058). DEFAULT false = record cloned grants WITHOUT firing the workflow
  // engine. true = each cloned grant fires the standard after-commit ACCESS_GRANTED workflow run.
  fireWorkflowsOnClonedGrants: z.boolean().default(false),
});

/**
 * The PER-ITEM result of a clone (ADR-0058 §4 / the ADR-0030 batch shape). `created` is the freshly
 * minted user (full UserSchema). `skipped` lists the requested assignment/grant ids that were a no-op,
 * each with a short reason ("not_found" — the id wasn't an active row of the source — or
 * "asset_deleted" — the assignment's asset is soft-deleted) so a partial clone is visible, not
 * swallowed. The new user + its mirrored rows commit in ONE transaction; the engine fires AFTER commit.
 */
export const CloneUserResultSchema = z.object({
  created: UserSchema,
  skipped: z.array(
    z.object({
      id: z.cuid(),
      reason: z.string(),
    }),
  ),
});

export type CloneUser = z.infer<typeof CloneUserSchema>;
export type CloneUserResult = z.infer<typeof CloneUserResultSchema>;
