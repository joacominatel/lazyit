import { createZodDto } from 'nestjs-zod';
import {
  AuditLogFilterOptionsSchema,
  AuditLogItemSchema,
  AuditLogPageSchema,
} from '@lazyit/shared';

// Audit-log READ DTOs (OpenAPI) from the shared zod schemas (issue #871). Read-only surface — no
// Create/Update DTOs; these only document the GET response shapes for Swagger. See ADR-0081.

/** One resolved audit-log row (metadata only, INV-10-safe). */
export class AuditLogItemDto extends createZodDto(AuditLogItemSchema) {}

/** Paginated `GET /audit/logs` envelope ({ items, total, limit, offset }) — ADR-0030. */
export class AuditLogPageDto extends createZodDto(AuditLogPageSchema) {}

/** `GET /audit/logs/filters` — the distinct human actors present for the chosen source. */
export class AuditLogFilterOptionsDto extends createZodDto(
  AuditLogFilterOptionsSchema,
) {}
