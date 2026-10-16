import type { ExportColumn } from '../common/export';
import type { AuditExportRow } from './audit.service';

/**
 * The Reports › audit file, in the shared `AUDIT_LOG_CSV_COLUMNS` order: one wide header for every source,
 * a source leaving the columns it lacks empty. Metadata only (INV-10): there is no value column.
 */
export const AUDIT_EXPORT_COLUMNS: readonly ExportColumn<AuditExportRow>[] = [
  { header: 'occurredAt', kind: 'date', value: (r) => r.occurredAt },
  { header: 'source', kind: 'text', value: (r) => r.source },
  { header: 'action', kind: 'text', value: (r) => r.action },
  { header: 'actorName', kind: 'text', value: (r) => r.actorName },
  {
    header: 'serviceAccountName',
    kind: 'text',
    value: (r) => r.serviceAccountName,
  },
  { header: 'vaultName', kind: 'text', value: (r) => r.vaultName },
  { header: 'itemLabel', kind: 'text', value: (r) => r.itemLabel },
  { header: 'targetUserName', kind: 'text', value: (r) => r.targetUserName },
  {
    header: 'targetServiceAccountName',
    kind: 'text',
    value: (r) => r.targetServiceAccountName,
  },
  { header: 'role', kind: 'text', value: (r) => r.role },
  { header: 'permission', kind: 'text', value: (r) => r.permission },
  { header: 'detail', kind: 'text', value: (r) => r.detail },
];
