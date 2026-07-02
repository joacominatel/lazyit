import { z } from "zod";
import { AccessRequestSchema } from "./access-request";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /access-requests` (and `GET /access-requests/mine`) envelope:
 * `{ items: AccessRequest[], total, limit, offset }`. Offset pagination per ADR-0030 — never a bare
 * array. Newest-first. The item is the full {@link AccessRequestSchema} (no relations are inlined on
 * the list), so only the page envelope is added.
 */
export const AccessRequestListPageSchema = pageSchema(AccessRequestSchema);

export type AccessRequestListPage = z.infer<typeof AccessRequestListPageSchema>;
