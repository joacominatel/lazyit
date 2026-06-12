import type { z } from "zod";
import {
  ArticleCategorySchema,
  CreateArticleCategorySchema,
  UpdateArticleCategorySchema,
} from "./article-category";

/**
 * Folder — the hierarchical successor to the flat ArticleCategory (ADR-0059 §1). The MODEL and TABLE
 * stay `ArticleCategory` / `article_categories` and the wire endpoints stay `/article-categories`
 * (the rename to `Folder` / `folders` is a deliberate follow-up — see the entity note); this is the
 * conceptual alias so api and web can speak in `Folder` terms today. The shape is exactly the
 * ArticleCategory contract WITH the self-ref `parentId` (null = a root folder).
 *
 * Folders carry NO access semantics here (ADR-0059 ships structure only). The per-folder access
 * boundary is ADR-0060's job. See docs/02-domain/entities/folder.md.
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
