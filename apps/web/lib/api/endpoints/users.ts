import type { CreateUser, UpdateUser, User } from "@lazyit/shared";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Pure data-access functions for the User resource — the ONLY place that talks
 * to `apiFetch` for users. Hooks (../hooks) wrap these in TanStack Query;
 * pages/components consume the hooks. The standard CRUD bodies come from
 * `createCrudEndpoints`, exposed under named, per-resource signatures.
 *
 * Routes mirror apps/api/src/users. Timestamps come back as ISO strings.
 */
const users = createCrudEndpoints<User, CreateUser, UpdateUser>("/users");

export const getUsers = users.list;
export const getUser = users.get;
export const createUser = users.create;
export const updateUser = users.update;
export const deleteUser = users.remove;
