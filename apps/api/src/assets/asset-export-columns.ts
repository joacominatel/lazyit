import type { ExportColumn } from '../common/export';
import type { AssetExportRow } from './assets.service';

// The Migrator reads this file back (ADR-0069): headers and order only ever grow at the end.
const INVENTORY_COLUMNS: readonly ExportColumn<AssetExportRow>[] = [
  { header: 'name', kind: 'text', value: (r) => r.name },
  { header: 'assetTag', kind: 'text', value: (r) => r.assetTag },
  { header: 'serial', kind: 'text', value: (r) => r.serial },
  { header: 'status', kind: 'text', value: (r) => r.status },
  { header: 'category', kind: 'text', value: (r) => r.model?.category?.name },
  { header: 'manufacturer', kind: 'text', value: (r) => r.model?.manufacturer },
  { header: 'model', kind: 'text', value: (r) => r.model?.name },
  { header: 'location', kind: 'text', value: (r) => r.location?.name },
  { header: 'company', kind: 'text', value: (r) => r.company },
  { header: 'purchaseDate', kind: 'date', value: (r) => r.purchaseDate },
  { header: 'warrantyEnd', kind: 'date', value: (r) => r.warrantyEnd },
  // Live owners only: someone who has left is not a current holder.
  {
    header: 'owners',
    kind: 'text',
    value: (r) =>
      r.assignments
        .filter((a) => a.user.deletedAt === null)
        .map((a) => `${a.user.firstName} ${a.user.lastName}`)
        .join('; '),
  },
  { header: 'notes', kind: 'text', value: (r) => r.notes },
  { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
  { header: 'updatedAt', kind: 'date', value: (r) => r.updatedAt },
  { header: 'purchaseCost', kind: 'money', value: (r) => r.purchaseCost },
  {
    header: 'purchaseCurrency',
    kind: 'text',
    value: (r) => r.purchaseCurrency,
  },
];

/** Appended only for a caller holding `purchaseOrder:read` (ADR-0099 §8, INV-PO-1). */
const PURCHASE_COLUMNS: readonly ExportColumn<AssetExportRow>[] = [
  {
    header: 'supplier',
    kind: 'text',
    value: (r) => r.purchaseOrderLine?.purchaseOrder.supplier?.name,
  },
  {
    header: 'purchaseReference',
    kind: 'text',
    value: (r) => r.purchaseOrderLine?.purchaseOrder.reference,
  },
  {
    header: 'invoiceNumbers',
    kind: 'text',
    value: (r) => r.purchaseOrderLine?.purchaseOrder.invoiceNumbers,
  },
];

export function assetExportColumns(
  includePurchase: boolean,
): readonly ExportColumn<AssetExportRow>[] {
  return includePurchase
    ? [...INVENTORY_COLUMNS, ...PURCHASE_COLUMNS]
    : INVENTORY_COLUMNS;
}
