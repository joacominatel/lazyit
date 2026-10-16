import type { ExportColumn } from '../common/export';
import type { PurchaseOrdersService } from './purchase-orders.service';

type ExportSource = ReturnType<PurchaseOrdersService['exportSource']>;

/** One purchase as the list shows it: supplier, derived receipt, totals and line count. */
export type PurchaseOrderExportRow = Awaited<
  ReturnType<ExportSource['fetchBatch']>
>[number];

// A purchase has one currency label, so its totals hold at most one group, in that `currency`.
export const PURCHASE_ORDER_EXPORT_COLUMNS: readonly ExportColumn<PurchaseOrderExportRow>[] =
  [
    { header: 'reference', kind: 'text', value: (r) => r.reference },
    { header: 'supplier', kind: 'text', value: (r) => r.supplier?.name },
    { header: 'status', kind: 'text', value: (r) => r.status },
    { header: 'receipt', kind: 'text', value: (r) => r.receipt?.state },
    { header: 'orderDate', kind: 'date', value: (r) => r.orderDate },
    { header: 'expectedDate', kind: 'date', value: (r) => r.expectedDate },
    { header: 'invoiceNumbers', kind: 'text', value: (r) => r.invoiceNumbers },
    { header: 'invoiceDate', kind: 'date', value: (r) => r.invoiceDate },
    { header: 'company', kind: 'text', value: (r) => r.company },
    { header: 'lineCount', kind: 'number', value: (r) => r.lineCount },
    {
      header: 'unitsOrdered',
      kind: 'number',
      value: (r) => r.receipt?.ordered,
    },
    {
      header: 'unitsReceived',
      kind: 'number',
      value: (r) => r.receipt?.received,
    },
    {
      header: 'unitsPending',
      kind: 'number',
      value: (r) => r.receipt?.pending,
    },
    { header: 'total', kind: 'money', value: (r) => r.totals[0]?.amount },
    { header: 'currency', kind: 'text', value: (r) => r.currency },
    {
      header: 'unpricedLines',
      kind: 'number',
      value: (r) => r.totals[0]?.unpricedLines ?? 0,
    },
    { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
  ];
