import type { ConsumableDeliveryTarget } from '@lazyit/shared';
import type { ExportColumn } from '../common/export';
import type {
  ConsumableExportRow,
  DeliveryExportRow,
  MovementExportRow,
} from './consumables.service';

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

function targetName(target: ConsumableDeliveryTarget | null): string | null {
  if (!target) return null;
  if (target.type === 'user') return target.displayName;
  if (target.type === 'asset') return target.label;
  return target.name;
}

function targetArchived(
  target: ConsumableDeliveryTarget | null,
): string | null {
  if (!target) return null;
  const flag = target.type === 'user' ? target.isOffboarded : target.isDeleted;
  return flag === null ? null : String(flag);
}

// The target cells as the ledger shows them: a target the caller cannot read keeps only its id (ADR-0098).
function targetColumns<
  R extends { target: ConsumableDeliveryTarget | null },
>(): ExportColumn<R>[] {
  return [
    { header: 'Target type', kind: 'text', value: (r) => r.target?.type },
    { header: 'Target ID', kind: 'text', value: (r) => r.target?.id },
    { header: 'Target', kind: 'text', value: (r) => targetName(r.target) },
    {
      header: 'Target archived',
      kind: 'text',
      value: (r) => targetArchived(r.target),
    },
  ];
}

/** `GET /consumables/:id/movements/export` columns, from the ledger row. */
export const MOVEMENT_EXPORT_COLUMNS: readonly ExportColumn<MovementExportRow>[] =
  [
    { header: 'Date', kind: 'date', value: (m) => m.createdAt },
    { header: 'Type', kind: 'text', value: (m) => m.type },
    { header: 'Quantity', kind: 'number', value: (m) => m.quantity },
    { header: 'Reason', kind: 'text', value: (m) => m.reason },
    { header: 'Notes', kind: 'text', value: (m) => m.notes },
    { header: 'Performed by', kind: 'text', value: (m) => m.performedById },
    ...targetColumns<MovementExportRow>(),
    {
      header: 'Returnable',
      kind: 'text',
      value: (m) => String(m.returnable),
    },
    { header: 'Return of', kind: 'number', value: (m) => m.returnOfId },
    {
      header: 'Purchase line ID',
      kind: 'text',
      value: (m) => m.purchaseOrderLineId,
    },
    { header: 'Movement ID', kind: 'number', value: (m) => m.id },
  ];

/** `GET /consumables/deliveries/export` columns, from the deliveries list item. */
export const DELIVERY_EXPORT_COLUMNS: readonly ExportColumn<DeliveryExportRow>[] =
  [
    { header: 'Delivered at', kind: 'date', value: (d) => d.createdAt },
    { header: 'Consumable', kind: 'text', value: (d) => d.consumable.name },
    { header: 'SKU', kind: 'text', value: (d) => d.consumable.sku },
    { header: 'Unit', kind: 'text', value: (d) => d.consumable.unit },
    {
      header: 'Consumable archived',
      kind: 'text',
      value: (d) => String(d.consumable.deletedAt !== null),
    },
    { header: 'Quantity', kind: 'number', value: (d) => d.quantity },
    {
      header: 'Returnable',
      kind: 'text',
      value: (d) => String(d.returnable),
    },
    { header: 'Returned', kind: 'number', value: (d) => d.returnedQuantity },
    {
      header: 'Outstanding',
      kind: 'number',
      value: (d) => d.outstandingQuantity,
    },
    ...targetColumns<DeliveryExportRow>(),
    { header: 'Reason', kind: 'text', value: (d) => d.reason },
    { header: 'Notes', kind: 'text', value: (d) => d.notes },
    { header: 'Performed by', kind: 'text', value: (d) => d.performedById },
    { header: 'Delivery ID', kind: 'number', value: (d) => d.id },
  ];
