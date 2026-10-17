import type { Prisma } from '../../generated/prisma/client';
import type { ExportColumn } from '../common/export';

export const ACCESS_REQUEST_EXPORT_SELECT = {
  id: true,
  createdAt: true,
  requesterId: true,
  applicationId: true,
  accessLevel: true,
  justification: true,
  status: true,
  decidedById: true,
  decidedAt: true,
  deniedReason: true,
  grantId: true,
  requester: { select: { firstName: true, lastName: true, email: true } },
  application: { select: { name: true } },
  decidedBy: { select: { firstName: true, lastName: true } },
} as const satisfies Prisma.AccessRequestSelect;

export type AccessRequestExportRow = Prisma.AccessRequestGetPayload<{
  select: typeof ACCESS_REQUEST_EXPORT_SELECT;
}>;

/** Which joined names this principal may read; without one, the cell keeps the id the list returns. */
export interface AccessRequestExportGates {
  /** `user:read`: requester and decider names, and the requester's email column. */
  users: boolean;
  /** `application:read`: the application name. */
  applications: boolean;
}

type Person = { firstName: string; lastName: string } | null;

export function accessRequestExportColumns(
  gates: AccessRequestExportGates,
): ExportColumn<AccessRequestExportRow>[] {
  const person = (id: string | null, p: Person) =>
    gates.users && p ? `${p.firstName} ${p.lastName}` : id;

  return [
    {
      header: 'Application',
      kind: 'text',
      value: (r) => (gates.applications ? r.application.name : r.applicationId),
    },
    {
      header: 'Requester',
      kind: 'text',
      value: (r) => person(r.requesterId, r.requester),
    },
    ...(gates.users
      ? [
          {
            header: 'Requester email',
            kind: 'text',
            value: (r) => r.requester.email,
          } satisfies ExportColumn<AccessRequestExportRow>,
        ]
      : []),
    { header: 'Access level', kind: 'text', value: (r) => r.accessLevel },
    { header: 'Justification', kind: 'text', value: (r) => r.justification },
    { header: 'Status', kind: 'text', value: (r) => r.status },
    { header: 'Requested at', kind: 'date', value: (r) => r.createdAt },
    {
      header: 'Decided by',
      kind: 'text',
      value: (r) => person(r.decidedById, r.decidedBy),
    },
    { header: 'Decided at', kind: 'date', value: (r) => r.decidedAt },
    { header: 'Denial reason', kind: 'text', value: (r) => r.deniedReason },
    { header: 'Grant ID', kind: 'text', value: (r) => r.grantId },
    { header: 'Request ID', kind: 'text', value: (r) => r.id },
  ];
}
