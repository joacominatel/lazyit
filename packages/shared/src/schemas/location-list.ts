import { z } from "zod";
import { LocationSchema } from "./location";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /locations` envelope (ADR-0030). The Location row is small (no blobs), so the list
 * item is the full {@link LocationSchema} — only the page envelope is added. Migrated off the
 * raw-array contract so `q` search and sort run server-side and authoritatively (no client-side
 * filtering past the backend window, which silently missed matches).
 */
export const LocationListPageSchema = pageSchema(LocationSchema);

export type LocationListPage = z.infer<typeof LocationListPageSchema>;
