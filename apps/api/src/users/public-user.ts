import type { Prisma, User } from '../../generated/prisma/client';

/**
 * The User columns that may leave the API (SEC-085). An ALLOWLIST, not a denylist: a column added to
 * `User` later stays server-side until someone adds it here on purpose. Every key is a `UserSchema`
 * field in `@lazyit/shared` (a spec pins that), so this is the column half of the public wire shape;
 * `manager` (resolved from `managerId`/`managerName`, ADR-0058) is added by the serializer.
 *
 * Never listed: `passwordHash`, `passwordUpdatedAt`, `sessionEpoch`, `mcpCredentialEpoch`,
 * `mustChangePassword` (credentials and revocation counters, ADR-0086/0097), the raw manager columns,
 * `notificationEmailOptOutTypes` (served by its own self-service endpoint) and the AD reconcile keys
 * `directorySourceId` / `directoryOffboardedAt` / `directoryReenabledAt` (ADR-0091).
 *
 * Use it two ways:
 *   - as a Prisma `select` whenever a relation embeds a User (`include: { user: { select: … } }`), so
 *     the credential columns are never even read for that response;
 *   - through {@link pickPublicUserColumns} when a whole row is already in hand (the auth guard's
 *     `@CurrentUser`, a `findFirst` the service also needs for guards).
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  isActive: true,
  role: true,
  externalId: true,
  legajo: true,
  username: true,
  directoryOnly: true,
  directoryAttrs: true,
  directorySource: true,
  locale: true,
  theme: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const satisfies Prisma.UserSelect;

export type PublicUserColumns = Pick<User, keyof typeof PUBLIC_USER_SELECT>;

const PUBLIC_USER_KEYS = Object.keys(
  PUBLIC_USER_SELECT,
) as (keyof typeof PUBLIC_USER_SELECT)[];

/** Copy ONLY the allowlisted columns off a user row; anything else on the row is dropped. */
export function pickPublicUserColumns(
  row: PublicUserColumns,
): PublicUserColumns {
  const out = {} as Record<string, unknown>;
  for (const key of PUBLIC_USER_KEYS) {
    out[key] = row[key];
  }
  return out as PublicUserColumns;
}
