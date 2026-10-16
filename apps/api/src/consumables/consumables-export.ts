import type { ExportColumn } from '../common/export';
import type { ConsumableExportRow } from './consumables.service';

/** The same comparison as the list's `lowStock` filter: a threshold is set and stock is at or below it. */
function isLowStock(row: ConsumableExportRow): boolean {
  return row.minStock !== null && row.currentStock <= row.minStock;
}

/** The consumables CSV columns (ADR-0103 allowlist), in output order. */
export const CONSUMABLE_EXPORT_COLUMNS: readonly ExportColumn<ConsumableExportRow>[] =
  [
    { header: 'name', kind: 'text', value: (r) => r.name },
    { header: 'sku', kind: 'text', value: (r) => r.sku },
    {
      header: 'category',
      kind: 'text',
      value: (r) =>
        r.category && r.category.deletedAt === null ? r.category.name : null,
    },
    { header: 'unit', kind: 'text', value: (r) => r.unit },
    { header: 'currentStock', kind: 'number', value: (r) => r.currentStock },
    { header: 'minStock', kind: 'number', value: (r) => r.minStock },
    {
      header: 'lowStock',
      kind: 'text',
      value: (r) => (isLowStock(r) ? 'true' : 'false'),
    },
    { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
    { header: 'updatedAt', kind: 'date', value: (r) => r.updatedAt },
  ];
