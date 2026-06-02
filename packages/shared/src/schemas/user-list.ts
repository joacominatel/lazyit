import { z } from "zod";
import { UserSchema } from "./user";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /users` envelope (ADR-0030). The User row is small (no blobs), so the list item is
 * the full {@link UserSchema} — only the page envelope is added. Migrated off the raw-array contract
 * so `q` search and sort run server-side and authoritatively (no client-side filtering past the
 * backend window, which silently missed matches once a team grows past one page).
 */
export const UserListPageSchema = pageSchema(UserSchema);

export type UserListPage = z.infer<typeof UserListPageSchema>;
