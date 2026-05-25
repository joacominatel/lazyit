/**
 * Parse the `activeOnly` query param shared by the assignment list endpoints
 * (`/asset-assignments`, `/assets/:id/assignments`, `/users/:id/assignments`).
 * Defaults to true: callers get only active assignments (releasedAt = null) unless they
 * explicitly pass `activeOnly=false`.
 */
export function parseActiveOnly(value?: string): boolean {
  return value === undefined ? true : value !== 'false';
}
