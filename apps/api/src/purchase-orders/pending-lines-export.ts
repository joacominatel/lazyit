import type { ExportColumn } from '../common/export';
import type { PurchaseReceivingService } from './purchase-receiving.service';

type ExportSource = ReturnType<
  PurchaseReceivingService['pendingLinesExportSource']
>;

/** One pending line as the Pending units list returns it, with its purchase header. */
export type PendingLineExportRow = Awaited<
  ReturnType<ExportSource['fetchBatch']>
>[number];

// The list's purchase header carries no delivery location, so neither does the file.
export const PENDING_LINE_EXPORT_COLUMNS: readonly ExportColumn<PendingLineExportRow>[] =
  [
    { header: 'lineId', kind: 'text', value: (r) => r.id },
    { header: 'purchaseId', kind: 'text', value: (r) => r.purchaseOrder.id },
    {
      header: 'purchaseReference',
      kind: 'text',
      value: (r) => r.purchaseOrder.reference,
    },
    {
      header: 'supplier',
      kind: 'text',
      value: (r) => r.purchaseOrder.supplier?.name,
    },
    {
      header: 'purchaseStatus',
      kind: 'text',
      value: (r) => r.purchaseOrder.status,
    },
    {
      header: 'orderDate',
      kind: 'date',
      value: (r) => r.purchaseOrder.orderDate,
    },
    {
      header: 'expectedDate',
      kind: 'date',
      value: (r) => r.purchaseOrder.expectedDate,
    },
    { header: 'kind', kind: 'text', value: (r) => r.kind },
    { header: 'description', kind: 'text', value: (r) => r.description },
    { header: 'manufacturer', kind: 'text', value: (r) => r.manufacturerText },
    { header: 'model', kind: 'text', value: (r) => r.modelText },
    { header: 'quantityOrdered', kind: 'number', value: (r) => r.quantity },
    {
      header: 'quantityCancelled',
      kind: 'number',
      value: (r) => r.cancelledQuantity,
    },
    {
      header: 'quantityReceived',
      kind: 'number',
      value: (r) => r.receivedQuantity,
    },
    {
      header: 'quantityPending',
      kind: 'number',
      value: (r) => r.pendingQuantity,
    },
  ];
