import { z } from "zod";
import { AccessGrantSchema } from "./access-grant";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /access-grants` envelope: `{ items: AccessGrant[], total, limit, offset }`. The
 * grant rows are already lean (no relations are inlined on this list), so the item is the full
 * {@link AccessGrantSchema} — only the page envelope is added.
 *
 * `GET /access-grants` is the most sensitive unbounded list (it can dump every user↔application
 * grant), so it is paginated first per ADR-0030. The nested
 * `GET /users/:id/access-grants` and `GET /applications/:id/access-grants` lists are inherently
 * scoped and stay unpaginated for now.
 */
export const AccessGrantListPageSchema = pageSchema(AccessGrantSchema);

export type AccessGrantListPage = z.infer<typeof AccessGrantListPageSchema>;
