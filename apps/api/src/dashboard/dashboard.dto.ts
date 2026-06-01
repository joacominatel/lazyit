import { createZodDto } from 'nestjs-zod';
import {
  DashboardSummarySchema,
  RecentActivityItemSchema,
  RecentActivityPageSchema,
} from '@lazyit/shared';

// Dashboard DTOs (OpenAPI schema) from the shared zod schemas. The dashboard is read-only, so there
// are no Create/Update DTOs — these only document the GET response shapes for Swagger.
// See docs/03-decisions/0018-api-documentation-swagger.md.

/** `GET /dashboard/summary` — the cross-pillar snapshot envelope. */
export class DashboardSummaryDto extends createZodDto(DashboardSummarySchema) {}

/** One normalized row of the unified activity feed (CEO Round 2 / ADR-0043). */
export class RecentActivityItemDto extends createZodDto(
  RecentActivityItemSchema,
) {}

/** Paginated `GET /dashboard/activity` envelope ({ items, total, limit, offset }) — ADR-0030. */
export class RecentActivityPageDto extends createZodDto(
  RecentActivityPageSchema,
) {}
