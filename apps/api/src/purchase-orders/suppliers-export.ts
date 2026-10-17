import type { ExportColumn } from '../common/export';
import type { Supplier } from '../../generated/prisma/client';

/** The suppliers CSV columns (ADR-0103 allowlist), in output order: the list row, field for field. */
export const SUPPLIER_EXPORT_COLUMNS: readonly ExportColumn<Supplier>[] = [
  { header: 'id', kind: 'text', value: (r) => r.id },
  { header: 'name', kind: 'text', value: (r) => r.name },
  { header: 'taxId', kind: 'text', value: (r) => r.taxId },
  { header: 'website', kind: 'text', value: (r) => r.website },
  {
    header: 'salesContactName',
    kind: 'text',
    value: (r) => r.salesContactName,
  },
  {
    header: 'salesContactEmail',
    kind: 'text',
    value: (r) => r.salesContactEmail,
  },
  {
    header: 'salesContactPhone',
    kind: 'text',
    value: (r) => r.salesContactPhone,
  },
  {
    header: 'supportContactName',
    kind: 'text',
    value: (r) => r.supportContactName,
  },
  {
    header: 'supportContactEmail',
    kind: 'text',
    value: (r) => r.supportContactEmail,
  },
  {
    header: 'supportContactPhone',
    kind: 'text',
    value: (r) => r.supportContactPhone,
  },
  { header: 'notes', kind: 'text', value: (r) => r.notes },
  { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
  { header: 'updatedAt', kind: 'date', value: (r) => r.updatedAt },
  { header: 'deletedAt', kind: 'date', value: (r) => r.deletedAt },
];
