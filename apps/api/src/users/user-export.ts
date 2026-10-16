import type { ManagerDescriptor } from '@lazyit/shared';
import type { ExportColumn } from '../common/export';
import type { SerializedUserListItem } from './users.service';

function managerName(manager: ManagerDescriptor | null): string | null {
  if (!manager) return null;
  return manager.type === 'user'
    ? `${manager.firstName} ${manager.lastName}`
    : manager.name;
}

/** `GET /users/export` columns, from the list row: never `externalId`, a credential or an epoch (ADR-0103 §2). */
export const USER_EXPORT_COLUMNS: readonly ExportColumn<SerializedUserListItem>[] =
  [
    { header: 'ID', kind: 'text', value: (u) => u.id },
    { header: 'First name', kind: 'text', value: (u) => u.firstName },
    { header: 'Last name', kind: 'text', value: (u) => u.lastName },
    { header: 'Email', kind: 'text', value: (u) => u.email },
    { header: 'Username', kind: 'text', value: (u) => u.username },
    { header: 'Employee number', kind: 'text', value: (u) => u.legajo },
    { header: 'Role', kind: 'text', value: (u) => u.role },
    { header: 'Active', kind: 'text', value: (u) => String(u.isActive) },
    {
      header: 'Directory person',
      kind: 'text',
      value: (u) => String(u.directoryOnly),
    },
    {
      header: 'Directory source',
      kind: 'text',
      value: (u) => u.directorySource,
    },
    { header: 'Manager', kind: 'text', value: (u) => managerName(u.manager) },
    {
      header: 'Assets held',
      kind: 'number',
      value: (u) => u.assetsInPossession,
    },
    { header: 'Active grants', kind: 'number', value: (u) => u.appAccesses },
    { header: 'Created', kind: 'date', value: (u) => u.createdAt },
    { header: 'Archived', kind: 'date', value: (u) => u.deletedAt },
  ];
