import type {
  AccessGrant,
  AssetAssignment,
  CreateUser,
  UpdateUser,
  User,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Pure data-access functions for the User resource — the ONLY place that talks
 * to `apiFetch` for users. Hooks (../hooks) wrap these in TanStack Query;
 * pages/components consume the hooks. The standard CRUD bodies come from
 * `createCrudEndpoints`, exposed under named, per-resource signatures, plus two
 * nested reads (a user's asset assignments + access grants) that back the
 * asset-centric per-person view on the user detail page.
 *
 * Routes mirror apps/api/src/users. Timestamps come back as ISO strings.
 */
const BASE = "/users";
const users = createCrudEndpoints<User, CreateUser, UpdateUser>(BASE);

export const getUsers = users.list;
export const getUser = users.get;
export const createUser = users.create;
export const updateUser = users.update;
export const deleteUser = users.remove;

/**
 * The current authenticated user (`GET /users/me`). The OIDC token does NOT carry the lazyit RBAC
 * role (ADR-0040), so the frontend reads the caller's role here to decide which admin-only controls
 * to show (e.g. the role Select). Returns the caller only — never another user.
 */
export function getCurrentUser(): Promise<User> {
  return apiFetch<User>(`${BASE}/me`);
}

/**
 * A user's asset assignments (`GET /users/:id/assignments`). Active-only by default; pass
 * `activeOnly: false` for the full ownership history. The rows are **bare** (`assetId` only — no
 * `asset`/`user` inline), so the user detail resolves the asset label client-side.
 */
export function getUserAssignments(
  userId: string,
  activeOnly = true,
): Promise<AssetAssignment[]> {
  return apiFetch<AssetAssignment[]>(
    `${BASE}/${userId}/assignments?activeOnly=${activeOnly}`,
  );
}

/**
 * A user's access grants (`GET /users/:id/access-grants`). Active-only by default; pass
 * `activeOnly: false` for revoked grants too. The rows are raw (`applicationId` only), so the user
 * detail resolves the application label client-side.
 */
export function getUserGrants(
  userId: string,
  activeOnly = true,
): Promise<AccessGrant[]> {
  return apiFetch<AccessGrant[]>(
    `${BASE}/${userId}/access-grants?activeOnly=${activeOnly}`,
  );
}
