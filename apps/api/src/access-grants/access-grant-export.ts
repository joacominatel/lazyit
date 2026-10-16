import type { Prisma } from '../../generated/prisma/client';
import type { ExportColumn } from '../common/export';

export const ACCESS_GRANT_EXPORT_SELECT = {
  id: true,
  createdAt: true,
  userId: true,
  applicationId: true,
  accessLevel: true,
  grantedAt: true,
  expiresAt: true,
  revokedAt: true,
  notes: true,
  grantedById: true,
  revokedById: true,
  grantedBySaId: true,
  revokedBySaId: true,
  user: { select: { firstName: true, lastName: true, email: true } },
  application: { select: { name: true } },
  grantedBy: { select: { firstName: true, lastName: true } },
  revokedBy: { select: { firstName: true, lastName: true } },
  grantedBySa: { select: { name: true } },
  revokedBySa: { select: { name: true } },
} as const satisfies Prisma.AccessGrantSelect;

export type AccessGrantExportRow = Prisma.AccessGrantGetPayload<{
  select: typeof ACCESS_GRANT_EXPORT_SELECT;
}>;

/** Which joined names this principal may read; without one, the cell keeps the id the list returns. */
export interface AccessGrantExportGates {
  /** `user:read`: grantee and human actor names, and the grantee's email column. */
  users: boolean;
  /** `application:read`: the application name. */
  applications: boolean;
  /** `settings:manage`, the service-account list's permission: service-account actor names. */
  serviceAccounts: boolean;
}

type Person = { firstName: string; lastName: string } | null;

function grantStatus(
  row: AccessGrantExportRow,
  now: Date,
): 'active' | 'expired' | 'revoked' {
  if (row.revokedAt) return 'revoked';
  // The list's includeExpired=false cut: past its expiry, not yet swept.
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

export function accessGrantExportColumns(
  gates: AccessGrantExportGates,
  now: Date,
): ExportColumn<AccessGrantExportRow>[] {
  const person = (id: string, p: Person) =>
    gates.users && p ? `${p.firstName} ${p.lastName}` : id;
  const actor = (
    userId: string | null,
    user: Person,
    saId: string | null,
    sa: { name: string } | null,
  ): string | null => {
    if (userId) return person(userId, user);
    if (saId)
      return `${gates.serviceAccounts && sa ? sa.name : saId} (service account)`;
    return null;
  };

  return [
    {
      header: 'Application',
      kind: 'text',
      value: (g) => (gates.applications ? g.application.name : g.applicationId),
    },
    { header: 'User', kind: 'text', value: (g) => person(g.userId, g.user) },
    ...(gates.users
      ? [
          {
            header: 'User email',
            kind: 'text',
            value: (g) => g.user.email,
          } satisfies ExportColumn<AccessGrantExportRow>,
        ]
      : []),
    { header: 'Access level', kind: 'text', value: (g) => g.accessLevel },
    { header: 'Status', kind: 'text', value: (g) => grantStatus(g, now) },
    { header: 'Granted at', kind: 'date', value: (g) => g.grantedAt },
    {
      header: 'Granted by',
      kind: 'text',
      value: (g) =>
        actor(g.grantedById, g.grantedBy, g.grantedBySaId, g.grantedBySa),
    },
    { header: 'Expires at', kind: 'date', value: (g) => g.expiresAt },
    { header: 'Revoked at', kind: 'date', value: (g) => g.revokedAt },
    {
      header: 'Revoked by',
      kind: 'text',
      value: (g) =>
        actor(g.revokedById, g.revokedBy, g.revokedBySaId, g.revokedBySa),
    },
    { header: 'Notes', kind: 'text', value: (g) => g.notes },
    { header: 'Grant ID', kind: 'text', value: (g) => g.id },
  ];
}
