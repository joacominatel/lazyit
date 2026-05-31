import { z } from "zod";
import { ArticleSchema } from "./article";
import { pageSchema } from "./pagination";

/**
 * Lean read shape for the article list (`GET /articles`). It is the full {@link ArticleSchema}
 * **minus `content`** — the entire Markdown body, the largest column in the schema — which a list
 * view never renders. `excerpt` is kept (that's what the list shows). The detail reads
 * (`GET /articles/:id`, `GET /articles/by-slug/:slug`) still return the full `Article` with `content`.
 *
 * See docs/03-decisions/0030-list-pagination-contract.md and the backend-performance-optimization
 * analysis (#3: "GET /articles ships the full markdown content of every article in the list").
 */
export const ArticleListItemSchema = ArticleSchema.omit({ content: true });

/** The paginated `GET /articles` envelope: `{ items: ArticleListItem[], total, limit, offset }`. */
export const ArticleListPageSchema = pageSchema(ArticleListItemSchema);

export type ArticleListItem = z.infer<typeof ArticleListItemSchema>;
export type ArticleListPage = z.infer<typeof ArticleListPageSchema>;
