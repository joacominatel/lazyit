import type { ExportColumn } from '../common/export';
import type { Location } from '../../generated/prisma/client';

// The list carries `parentId` only, so the hierarchy is rebuilt from `id` / `parentId`, not a path.
export const LOCATION_EXPORT_COLUMNS: readonly ExportColumn<Location>[] = [
  { header: 'id', kind: 'text', value: (r) => r.id },
  { header: 'name', kind: 'text', value: (r) => r.name },
  { header: 'type', kind: 'text', value: (r) => r.type },
  { header: 'parentId', kind: 'text', value: (r) => r.parentId },
  { header: 'address', kind: 'text', value: (r) => r.address },
  { header: 'floor', kind: 'text', value: (r) => r.floor },
  { header: 'description', kind: 'text', value: (r) => r.description },
  { header: 'notes', kind: 'text', value: (r) => r.notes },
  { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
  { header: 'updatedAt', kind: 'date', value: (r) => r.updatedAt },
  { header: 'deletedAt', kind: 'date', value: (r) => r.deletedAt },
];
