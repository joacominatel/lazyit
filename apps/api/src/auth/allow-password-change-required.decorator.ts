import { SetMetadata } from '@nestjs/common';

/** Reflector key the {@link MustChangePasswordGuard} reads to exempt a route from the forced-change gate. */
export const ALLOW_PASSWORD_CHANGE_REQUIRED_KEY = 'allowPasswordChangeRequired';

/**
 * Marks a route as reachable EVEN WHILE the caller still owes a forced password change (ADR-0086 §F4,
 * `mustChangePassword`). The {@link MustChangePasswordGuard} otherwise blocks every authenticated route
 * with a `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` until the user changes their one-time credential.
 *
 * Apply it to the narrow set the frontend needs to DETECT the state and COMPLETE the change:
 *   - `POST /auth/change-password` — the escape hatch itself (else the gate would be a deadlock).
 *   - `GET /users/me` — the self-read that carries `mustChangePassword`, so the web can render the wall.
 * `@Public()` routes (e.g. `/config/status`, the public reset endpoints) are already exempt — they carry
 * no authenticated user for the gate to act on.
 */
export const AllowPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true);
