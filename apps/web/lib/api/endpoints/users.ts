import type {
  AccessGrant,
  AssetAssignment,
  CloneUser,
  CloneUserResult,
  CreateUser,
  UpdateUser,
  User,
  UserListPage,
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
 * page. `limit`/`offset` thread the pagination window (ADR-0030). `deleted: "only"` is the
 * ADMIN-only archived view (soft-deleted / offboarded users).
 */
export interface UserListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
}

/**
 * List users, paged. `GET /users` returns a `UserListPage` envelope (the ADR-0030 page over
 * {@link UserListItem}): the full User row PLUS the optional, batched #386 activity counts
 * (`assetsInPossession` / `appAccesses`). We return the whole envelope (`items` +
 * `total`/`limit`/`offset`) so the list can paginate and the column picker can read the counts.
 * Only the server-supported params are forwarded (extra client-only filter keys are ignored).
 * Default is active-only; pass `deleted: "only"` (ADMIN) for the archived view.
 */
export function getUsers(params: UserListParams = {}): Promise<UserListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  const search = qs.toString();
  return apiFetch<UserListPage>(search ? `${BASE}?${search}` : BASE);
}
export const getUser = users.get;
export const createUser = users.create;
export const updateUser = users.update;
export const deleteUser = users.remove;

/**
 * Clone a user with chosen actions (`POST /users/:id/clone`, `user:manage` — ADR-0058). `sourceId` is
 * the template (must be live); the body mints a NEW user (`profile`) and opt-in mirrors the source's
 * selected ACTIVE asset assignments + access grants as new append-only rows. `fireWorkflowsOnClonedGrants`
 * (default false in the schema) decides whether cloned grants fire the workflow engine. Resolves to the
 * per-item result so the caller can surface the created user + the `skipped` list with reasons.
 */
export function cloneUser(
  sourceId: string,
  body: CloneUser,
): Promise<CloneUserResult> {
  return apiFetch<CloneUserResult>(`${BASE}/${sourceId}/clone`, {
    method: "POST",
    body,
  });
}

/**
 * What an offboarding reclaimed/revoked — the `POST /users/:id/offboard` (and `DELETE /users/:id`)
 * response. Mirrors the API's `OffboardResult` (apps/api/src/users/users.service.ts).
 *
 * Defined here (not in `@lazyit/shared`) on purpose: it is a read-only response DTO with no
 * validated request payload, and the shared package is the home for zod schemas / inferred types,
 * not hand-written response interfaces. If a future endpoint needs to validate this shape, promote
 * it to a shared zod schema then.
 */
export interface OffboardResult {
  /** The soft-deleted user (deletedAt stamped). */
  userId: string;
  /** Asset assignments released (reclaimed assets), by id. */
  releasedAssignments: { id: string; assetId: string }[];
  /** Count of active access grants revoked. */
  revokedGrants: number;
}

/**
 * Offboard a user (`POST /users/:id/offboard`, `user:manage`). The intention-revealing alias of
 * `DELETE /users/:id`: in one transaction it soft-deletes the user, revokes ALL their active access
 * grants and releases ALL their active asset assignments (with RELEASED history). Returns the
 * offboarding summary so the UI can confirm honestly what was reclaimed. History is preserved —
 * a soft delete, never an erase. Re-onboarding ({@link restoreUser}) does NOT re-grant access or
 * re-assign assets (ADR-0041); those are separate, intentional acts.
 */
export function offboardUser(id: string): Promise<OffboardResult> {
  return apiFetch<OffboardResult>(`${BASE}/${id}/offboard`, { method: "POST" });
}

/**
 * Restore (re-onboard) a soft-deleted user (`POST /users/:id/restore`, ADMIN). Clears `deletedAt` so
 * the account exists and can log in again; does NOT re-grant prior access/assignments (ADR-0041).
 */
export function restoreUser(id: string): Promise<User> {
  return apiFetch<User>(`${BASE}/${id}/restore`, { method: "POST" });
}

/**
 * Trigger a password reset for a user (`POST /users/:id/reset-password`, `user:manage`). The IdP
 * (Zitadel) emails the reset link via ITS SMTP — lazyit never sees or sets the password. Resolves on
 * 204 (no body). The honest non-success cases come back as an {@link ApiError} the caller maps on its
 * `.status`:
 *   - **501** — managed by the identity provider: BYOI (generic-oidc) or a user with no IdP link
 *     (`externalId == null`); lazyit cannot drive a reset for them.
 *   - **422** — the user is inactive (offboarded), so a reset is meaningless.
 *   - **404** — the user is missing or soft-deleted.
 * Delivery still depends on the IdP's SMTP being configured.
 */
export function resetUserPassword(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id}/reset-password`, { method: "POST" });
}

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
