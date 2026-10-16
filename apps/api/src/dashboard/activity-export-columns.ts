import type { ExportColumn } from '../common/export';
import type { ActivityExportRow } from './dashboard.service';

/** The Reports › activity file: the feed's when / what / who, in the shared `RECENT_ACTIVITY_CSV_COLUMNS` order. */
export const ACTIVITY_EXPORT_COLUMNS: readonly ExportColumn<ActivityExportRow>[] =
  [
    { header: 'occurredAt', kind: 'date', value: (r) => r.occurredAt },
    { header: 'action', kind: 'text', value: (r) => r.action },
    { header: 'entityType', kind: 'text', value: (r) => r.entityType },
    { header: 'entityId', kind: 'text', value: (r) => r.entityId },
    { header: 'actorName', kind: 'text', value: (r) => r.actorName },
    { header: 'summary', kind: 'text', value: (r) => r.summary },
  ];
