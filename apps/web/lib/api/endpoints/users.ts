import type {
  AccessGrant,
  AdminPasswordResetOutcome,
  AdminPasswordResetRequest,
  AdminPasswordResetResult,
  AssetAssignment,
  CloneUser,
  CloneUserResult,
  CreateUser,
  PasswordResetCapabilities,
  Role,
  RoleCounts,
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
  /**
   * Directory-person filter (ADR-0069 REDESIGN §0 #2). `true` → only directory people (no login, created
   * by the bulk import); `false` → only real accounts; omitted → both. A directory person IS a User (the
   * list mixes them, badged "Directory"), so this is the optional slice that lets an operator focus on one.
   */
  directoryOnly?: boolean;
  /**
   * RBAC role filter (#693). Scope the list to one role (ADMIN | MEMBER | VIEWER); omitted → all roles.
   * The Settings → Roles "View N members" link deep-links here as `/users?role=VIEWER`, so the list IS
   * the role-membership browser (server-side search/sort/paging) — no separate per-role view.
   */
  role?: Role;
  /**
   * Batch id→name resolver filter (#961). Scope the list to exactly these user ids (`id IN (…)`) — the
   * read-only name-resolution path behind {@link useUserNames}, which replaced the truncated
   * whole-directory read. Sent comma-encoded (`?ids=a,b,c`); de-duplicated + capped
   * (`MAX_RESOLVE_USER_IDS`) and each validated as a UUID server-side. Pair with `limit` ≥ the id count.
   */
  ids?: string[];
}

/**
 * List users, paged. `GET /users` returns a `UserListPage` envelope (the ADR-0030 page over
 * {@link UserListItem}): the full User row PLUS the optional, batched #386 activity counts
 * (`assetsInPossession` / `appAccesses`). We return the whole envelope (`items` +
 * `total`/`limit`/`offset`) so the list can paginate and the column picker can read the counts.
 * Only the server-supported params are forwarded (extra client-only filter keys are ignored).
 * Default is active-only; pass `deleted: "only"` (ADMIN) for the archived view.
 */
export function getUsers(
  params: UserListParams = {},
  signal?: AbortSignal,
  // Optional Bearer override for SSR server-prefetch (ADR-0067) — see `getAssets`.
  token?: string,
): Promise<UserListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  if (params.directoryOnly !== undefined)
    qs.set("directoryOnly", String(params.directoryOnly));
  if (params.role) qs.set("role", params.role);
  // Batch id→name resolver (#961): comma-encoded ids so a whole set rides one param.
  if (params.ids && params.ids.length > 0) qs.set("ids", params.ids.join(","));
  const search = qs.toString();
  return apiFetch<UserListPage>(search ? `${BASE}?${search}` : BASE, {
    signal,
    token,
  });
}
/**
 * Per-role LIVE user counts (`GET /users/role-counts`, #693). One server-side `groupBy` over the
 * active directory → `{ ADMIN, MEMBER, VIEWER }`. Backs the Settings → Roles card counts so they stay
 * correct at any team size (the old client-side count truncated past the list window). Every role key
 * is always present (`0` when the role has no holders).
 */
export function getUserRoleCounts(signal?: AbortSignal): Promise<RoleCounts> {
  return apiFetch<RoleCounts>(`${BASE}/role-counts`, { signal });
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
  /**
   * Count of Secret-vault crypto memberships hard-dropped (issue #869). INV-10-safe: revoking a
   * membership is a pure row-delete of wrapped key material — the server never decrypts anything.
   */
  revokedVaultMemberships: number;
  /**
   * The vaults the departing user could read, as a ROTATION PROMPT (issue #869). Pure METADATA only —
   * vault name + live item count, never a value/key/ciphertext. Informational: lazyit cannot auto-rotate
   * (the server can't re-encrypt — zero-knowledge), so an operator must rotate these secrets manually.
   * Empty when the user was a member of no vault.
   */
  rotationVaults: { vaultId: string; name: string; itemCount: number }[];
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
 * Provision an OIDC account for a directory person (`POST /users/:id/provision-account`, `user:manage` —
 * ADR-0069 REDESIGN §0 #3). The manual counterpart to the auto-claim-by-verified-email login (ADR-0038):
 * it takes an existing directory-only person (no login, `externalId == null`), creates them in the
 * bundled identity provider (Zitadel), sets `externalId` and flips `directoryOnly` to false. Resolves to
 * the now-promoted {@link User}. The honest non-success cases come back as an {@link ApiError} the caller
 * maps on its `.status`:
 *   - **400** — the target is not a directory person, is already linked, OR has no real email (Zitadel
 *     requires one; a synthesized `…@directory.local` placeholder counts as "no email"). The operator
 *     must edit the person and give them a real email first.
 *   - **503** — the IdP create failed.
 */
export function provisionUserAccount(id: string): Promise<User> {
  return apiFetch<User>(`${BASE}/${id}/provision-account`, { method: "POST" });
}

/**
 * Onboard a directory person in LOCAL auth mode (`POST /users/:id/provision-local-account`, `user:manage`
 * — ADR-0086 §5 / issue #1072). The local-mode counterpart to {@link provisionUserAccount}: for an
 * imported, login-less directory person it mints a ONE-TIME temporary password, flips them into a login
 * account (keeping their role), and resolves to the temp password — shown ONCE, never refetchable. Only
 * meaningful when `canProvisionLocalAccounts` is set on `GET /config/status` (local mode); the backend
 * 400s outside local mode or for a non-directory target, surfaced as an {@link ApiError} on `.status`.
 */
export function provisionLocalUserAccount(
  id: string,
): Promise<AdminPasswordResetResult> {
  return apiFetch<AdminPasswordResetResult>(
    `${BASE}/${id}/provision-local-account`,
    { method: "POST" },
  );
}

/**
 * Trigger a password reset for a user (`POST /users/:id/reset-password`, `user:manage`). What this does
 * depends on the instance auth mode, so the result type is a union (ADR-0086 §5, issue #1268):
 *   - **OIDC / bundled Zitadel** — the IdP emails the reset link via ITS SMTP; lazyit never sees or sets
 *     the password. Resolves on **204** with no body (`void`). Send NO `body` here.
 *   - **AUTH_MODE=local** — lazyit owns the credential, so the admin picks the delivery explicitly in
 *     `body`: `"email"` sends a single-use reset link through the INSTANCE SMTP, `"temporary-password"`
 *     mints a one-time password returned ONCE. Resolves **200** with an {@link AdminPasswordResetOutcome}.
 *
 * `body` is optional so omitting it keeps the pre-#1268 behavior byte-identical on both paths (an older
 * web build against a newer API still works — upgrade-safety, CLAUDE.md §8). Ask
 * {@link getPasswordResetCapabilities} which deliveries the instance can actually offer before choosing.
 *
 * The honest non-success cases come back as an {@link ApiError} the caller maps on its `.status`:
 *   - **501** — managed by the identity provider: BYOI (generic-oidc) or a user with no IdP link
 *     (`externalId == null`) in OIDC mode; lazyit cannot drive a reset for them.
 *   - **422** — the user is inactive (offboarded) or directory-only, so a reset is meaningless.
 *   - **409** — the `email` delivery is unavailable right now; the body carries a
 *     `PasswordResetEmailUnavailableReason` (`smtp-not-configured` / `origin-unknown`).
 *   - **503** — the reset email failed to send (this path never fakes a cheerful success).
 *   - **404** — the user is missing or soft-deleted.
 */
export function resetUserPassword(
  id: string,
  body?: AdminPasswordResetRequest,
): Promise<AdminPasswordResetOutcome | void> {
  return apiFetch<AdminPasswordResetOutcome | void>(
    `${BASE}/${id}/reset-password`,
    { method: "POST", body },
  );
}

/**
 * What the admin password-reset action may offer on THIS instance
 * (`GET /users/password-reset-capabilities`, `user:manage`). Resolved server-side so the dialog can
 * enable/disable each delivery honestly instead of guessing from `externalId` (issue #1268).
 *
 * It deliberately does NOT ride the `@Public` `GET /config/status`: whether the instance has working
 * outbound email is operational detail an anonymous visitor has no business reading, so it sits behind
 * the same permission that owns the action. A **404** here means an API older than #1268 — callers must
 * fall back to the pre-#1268 (OIDC-only) behavior rather than breaking the Users page.
 */
export function getPasswordResetCapabilities(
  signal?: AbortSignal,
): Promise<PasswordResetCapabilities> {
  return apiFetch<PasswordResetCapabilities>(
    `${BASE}/password-reset-capabilities`,
    { signal },
  );
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
