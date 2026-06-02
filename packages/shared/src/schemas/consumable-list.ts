import { z } from "zod";
import { ConsumableSchema } from "./consumable";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /consumables` envelope (ADR-0030). The Consumable row is small (no blobs), so the
 * list item is the full {@link ConsumableSchema} — only the page envelope is added. Migrated off the
 * raw-array contract so `q` search and sort run server-side and authoritatively (no client-side
 * filtering past the backend window, which silently missed matches).
 */
export const ConsumableListPageSchema = pageSchema(ConsumableSchema);

export type ConsumableListPage = z.infer<typeof ConsumableListPageSchema>;
