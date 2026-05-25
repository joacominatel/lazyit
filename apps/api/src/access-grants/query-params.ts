/**
 * Boolean query params shared by the access-grant list endpoints (`/access-grants`,
 * `/users/:id/access-grants`, `/applications/:id/access-grants`). Both default to `true` and only
 * `=false` flips them — anything else (including a bare `?activeOnly`) is treated as `true`.
 */

/**
 * `activeOnly` — defaults to true: only active grants (`revokedAt = null`) unless `activeOnly=false`.
 */
export function parseActiveOnly(value?: string): boolean {
  return value === undefined ? true : value !== 'false';
}

/**
 * `includeExpired` — defaults to true: grants past their `expiresAt` (but not revoked) are still
 * listed unless `includeExpired=false`. `expiresAt` is informative and never changes activeness
 * (no auto-revoke — see docs/03-decisions/0023-access-management-design.md).
 */
export function parseIncludeExpired(value?: string): boolean {
  return value === undefined ? true : value !== 'false';
}
