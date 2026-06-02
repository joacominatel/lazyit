import { z } from "zod";
import { ApplicationSchema } from "./application";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /applications` envelope (ADR-0030). The Application row carries no heavy blobs that
 * a list never renders (the only Json field, `metadata`, is small), so the list item is the full
 * {@link ApplicationSchema} — only the page envelope is added. Migrated off the raw-array contract so
 * search (`q`) and sort are server-side and authoritative (no silent truncation past the window).
 */
export const ApplicationListPageSchema = pageSchema(ApplicationSchema);

export type ApplicationListPage = z.infer<typeof ApplicationListPageSchema>;
