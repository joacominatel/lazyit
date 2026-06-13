-- KB folder access control (ADR-0060 §3 / INV-9). Adds the per-folder restriction store: a nullable
-- jsonb `accessRules` on `article_categories`. NULL = PUBLIC (the default — preserves the pre-0060
-- public-to-authenticated behaviour); a non-null value is an OR-combined list of the CLOSED rule
-- vocabulary (FolderAccessRulesSchema in @lazyit/shared): `users` / `role` / `appGrant` /
-- `assetAssignment`. The shape is validated by zod at the DTO edge (catalog-as-code, ADR-0007) — a
-- jsonb column, NOT a per-article ACL table: the rule attaches to the FOLDER (a bounded named set) and
-- articles inherit their home folder's rule. The dynamic kinds (appGrant/assetAssignment) are evaluated
-- DB-first at read time via EXISTS over the live AccessGrant/AssetAssignment joins (never materialised),
-- so they need no extra column here.

-- AlterTable
ALTER TABLE "article_categories" ADD COLUMN     "accessRules" JSONB;
