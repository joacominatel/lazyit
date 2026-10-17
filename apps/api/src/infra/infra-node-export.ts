import type { ExportColumn } from '../common/export';
import type { InfraNodeExportRow } from './infra.service';

// The Servers page row minus specs, externalId, reportingSource, shortcuts and canvas x/y (ADR-0103 §2).
export const INFRA_NODE_EXPORT_COLUMNS: readonly ExportColumn<InfraNodeExportRow>[] =
  [
    { header: 'Label', kind: 'text', value: (n) => n.label },
    { header: 'Kind', kind: 'text', value: (n) => n.kind },
    { header: 'Status', kind: 'text', value: (n) => n.status },
    { header: 'State', kind: 'text', value: (n) => n.state },
    { header: 'Source', kind: 'text', value: (n) => n.source },
    { header: 'IP address', kind: 'text', value: (n) => n.ipAddress },
    { header: 'Chassis', kind: 'text', value: (n) => n.chassis },
    { header: 'Asset', kind: 'text', value: (n) => n.assetName },
    {
      header: 'Owners',
      kind: 'text',
      value: (n) =>
        n.owners.map((o) => `${o.firstName} ${o.lastName}`).join('; ') || null,
    },
    { header: 'Agent version', kind: 'text', value: (n) => n.agentVersion },
    {
      header: 'Last reported at',
      kind: 'date',
      value: (n) => n.lastReportedAt,
    },
    { header: 'Created at', kind: 'date', value: (n) => n.createdAt },
    { header: 'Updated at', kind: 'date', value: (n) => n.updatedAt },
    { header: 'Asset ID', kind: 'text', value: (n) => n.assetId },
    { header: 'Node ID', kind: 'text', value: (n) => n.id },
  ];
