import type { ExportColumn } from '../common/export';
import type { ApplicationsService } from './applications.service';

type ExportSource = ReturnType<ApplicationsService['exportSource']>;

/** One application as the list returns it: money in minor units plus the derived `seatsUsed`. */
export type ApplicationExportRow = Awaited<
  ReturnType<ExportSource['fetchBatch']>
>[number];

// The list carries only `categoryId` (the name is a `category:read` lookup) and a free-form `metadata` JSON.
export const APPLICATION_EXPORT_COLUMNS: readonly ExportColumn<ApplicationExportRow>[] =
  [
    { header: 'id', kind: 'text', value: (r) => r.id },
    { header: 'name', kind: 'text', value: (r) => r.name },
    { header: 'vendor', kind: 'text', value: (r) => r.vendor },
    { header: 'url', kind: 'text', value: (r) => r.url },
    { header: 'description', kind: 'text', value: (r) => r.description },
    {
      header: 'isCritical',
      kind: 'text',
      value: (r) => String(r.isCritical),
    },
    {
      header: 'seatsPurchased',
      kind: 'number',
      value: (r) => r.seatsPurchased,
    },
    { header: 'seatsUsed', kind: 'number', value: (r) => r.seatsUsed },
    { header: 'costPerSeat', kind: 'money', value: (r) => r.costPerSeat },
    { header: 'renewalDate', kind: 'date', value: (r) => r.renewalDate },
    { header: 'notes', kind: 'text', value: (r) => r.notes },
    { header: 'createdAt', kind: 'date', value: (r) => r.createdAt },
    { header: 'updatedAt', kind: 'date', value: (r) => r.updatedAt },
    { header: 'deletedAt', kind: 'date', value: (r) => r.deletedAt },
  ];
