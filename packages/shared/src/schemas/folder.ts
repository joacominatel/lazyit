import { z } from "zod";
import {
  ArticleCategorySchema,
  CreateArticleCategorySchema,
  UpdateArticleCategorySchema,
} from "./article-category";
import { RoleSchema } from "./user";

/**
 * Folder — the hierarchical successor to the flat ArticleCategory (ADR-0059 §1). The MODEL and TABLE
 * stay `ArticleCategory` / `article_categories` and the wire endpoints stay `/article-categories`
 * (the rename to `Folder` / `folders` is a deliberate follow-up — see the entity note); this is the
 * conceptual alias so api and web can speak in `Folder` terms today. The shape is exactly the
 * ArticleCategory contract WITH the self-ref `parentId` (null = a root folder).
 *
 * Folders DO carry access semantics as of ADR-0060: a folder is the KB permission boundary, and a
 * restricted folder narrows the audience of an otherwise-public article via the OR-combined rule
 * vocabulary below. The structural ADR (0059) ships the tree; this file adds ADR-0060's rule shape.
 * See docs/02-domain/entities/folder.md.
 */

/** The full persisted Folder entity — identical to {@link ArticleCategorySchema} (incl. `parentId`). */
export const FolderSchema = ArticleCategorySchema;

/** Payload to create a Folder — identical to {@link CreateArticleCategorySchema}. */
export const CreateFolderSchema = CreateArticleCategorySchema;

/** Payload to update/move a Folder — identical to {@link UpdateArticleCategorySchema}. */
export const UpdateFolderSchema = UpdateArticleCategorySchema;

export type Folder = z.infer<typeof FolderSchema>;
export type CreateFolder = z.infer<typeof CreateFolderSchema>;
export type UpdateFolder = z.infer<typeof UpdateFolderSchema>;

// --- folder access control (ADR-0060) ----------------------------------------

/**
 * The CLOSED folder-access rule vocabulary (ADR-0060 §3). A *restricted* folder carries one or more
 * rules **combined with OR** (any rule that matches lets a caller in); absence/empty = PUBLIC (§2,
 * {@link isPublicAccessRules}). Every kind is expressible from data lazyit already has — NO new
 * ownership column on Article or Folder — and is evaluated **DB-first at read time** (the api resolves
 * the dynamic ones via `EXISTS` over the live lifecycle joins, so access follows offboarding
 * automatically). The kinds are a reviewable, catalog-as-code closed set (ADR-0007 discipline), never
 * free-form policy — a `z.discriminatedUnion` on `kind` rejects an unknown kind or an extra key.
 *
 * - `users`           — an explicit set of users may read the folder (§3a).
 * - `role`            — holders of a given `User.role` may read it (§3b).
 * - `appGrant`        — holders of an ACTIVE AccessGrant (`revokedAt IS NULL`) to the application (§3c).
 * - `assetAssignment` — current assignees (`releasedAt IS NULL`) of the asset (§3d).
 */
export const FolderAccessRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("users"),
    // At least one explicit user; an empty set would restrict to nobody (meaningless — rejected). The
    // ids are `User.id`s (uuid — ADR-0005). Capped so a single rule can't carry an unbounded list.
    userIds: z.array(z.uuid()).min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("role"),
    role: RoleSchema,
  }),
  z.strictObject({
    kind: z.literal("appGrant"),
    applicationId: z.cuid(),
  }),
  z.strictObject({
    kind: z.literal("assetAssignment"),
    assetId: z.cuid(),
  }),
]);

export type FolderAccessRule = z.infer<typeof FolderAccessRuleSchema>;

/**
 * A folder's stored restriction: an OR-combined list of {@link FolderAccessRuleSchema} rules, or
 * `null` for PUBLIC (the default — preserves the pre-0060 public-to-authenticated behaviour). Bounded
 * to a handful per folder (ADR-0060: "a handful of OR rules per folder, small team") so read-time
 * evaluation stays cheap. The persisted jsonb column on `ArticleCategory` validates against this.
 */
export const FolderAccessRulesSchema = z
  .array(FolderAccessRuleSchema)
  .max(20)
  .nullable();

export type FolderAccessRules = z.infer<typeof FolderAccessRulesSchema>;

/**
 * PUBLIC fast-path predicate (ADR-0060 §2): a folder is PUBLIC when it has NO restriction rule —
 * `null`, `undefined`, or an empty array. A non-empty rule list narrows the audience. This is the one
 * indexed check the common (unrestricted) folder pays before any `EXISTS` subquery runs.
 */
export function isPublicAccessRules(
  rules: FolderAccessRules | undefined,
): boolean {
  return rules == null || rules.length === 0;
}

/**
 * The PUT body to set or clear a folder's access rules (the per-folder rule editor's write contract).
 * `accessRules: null` CLEARS the restriction (makes the folder PUBLIC again); a list REPLACES it.
 * Strict: the `accessRules` key is required (a missing key is a 400, not a silent no-op).
 */
export const UpdateFolderAccessRulesSchema = z.strictObject({
  accessRules: FolderAccessRulesSchema,
});

export type UpdateFolderAccessRules = z.infer<
  typeof UpdateFolderAccessRulesSchema
>;
