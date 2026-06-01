import type {
  AccessGrant,
  AssetAssignment,
  CreateUser,
  Page,
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

/**
 * Server-side params for the user list (#104). `q` matches firstName/lastName/email;
 * `sort` is allowlisted to `firstName|lastName|email|role|createdAt` (unknown → 400). The
 * active/inactive status filter is NOT a server param — the screen applies it client-side over the
 * page. `limit`/`offset` thread the pagination window (ADR-0030).
 */
export interface UserListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * List non-deleted users, paged. `GET /users` returns a `Page<User>` envelope; we return the whole
 * envelope (`items` + `total`/`limit`/`offset`) so the list can paginate. Only the server-supported
 * params are forwarded (extra client-only filter keys are ignored).
 */
export function getUsers(params: UserListParams = {}): Promise<Page<User>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const search = qs.toString();
  return apiFetch<Page<User>>(search ? `${BASE}?${search}` : BASE);
}
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
