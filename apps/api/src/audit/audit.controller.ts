import { Readable } from 'node:stream';
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type {
  AuditLogFilters,
  AuditLogQuery,
  AuditLogSource,
} from '@lazyit/shared';
import {
  AUDIT_ACTIONS_BY_SOURCE,
  AUDIT_LOG_SOURCES,
  AuditLogFiltersSchema,
  AuditLogQuerySchema,
  AuditLogSourceSchema,
} from '@lazyit/shared';
import { AuditService } from './audit.service';
import { AuditLogFilterOptionsDto, AuditLogPageDto } from './audit.dto';
import { RequirePermission } from '../auth/require-permission.decorator';

/** Flattened `source → allowed actions` doc string for the Swagger `action` param. */
const ACTIONS_DOC = (Object.keys(AUDIT_ACTIONS_BY_SOURCE) as AuditLogSource[])
  .map((source) => `${source}: ${AUDIT_ACTIONS_BY_SOURCE[source].join(' | ')}`)
  .join('; ');

/**
 * Read + filtered CSV export of the three SECURITY audit logs (issue #871, ADR-0081) — the reader for
 * `SecretAuditLog`, `PermissionAuditLog` and `ServiceAccountAuditLog`, which are written but were never
 * readable. All endpoints reuse the SAME `logs:read` permission that gates Reports (no new verb).
 *
 * Clones the Reports/activity controller mold verbatim: offset paging, a `StreamableFile` + async
 * generator CSV export (never buffers the whole result), and a distinct-actor filter menu. Source-
 * scoped via a required `source` param. INV-10-safe secret resolution lives in {@link AuditService}.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('logs/filters')
  @RequirePermission('logs:read')
  @ApiOperation({
    summary:
      'Distinct HUMAN actors present for the chosen audit source (mirrors /dashboard/activity/filters): id + display name, for the actor filter select. Actions are NOT returned — the web derives them from the shared per-source action enums so a new enum value appears automatically. Gated on logs:read.',
  })
  @ApiQuery({
    name: 'source',
    required: true,
    enum: AUDIT_LOG_SOURCES,
    description:
      'Which audit log to read (secret | permission | serviceAccount).',
  })
  @ApiOkResponse({ type: AuditLogFilterOptionsDto })
  async filters(@Query('source') source?: string) {
    return this.audit.getFilterOptions(this.parseSource(source));
  }

  @Get('logs')
  @RequirePermission('logs:read')
  @ApiOperation({
    summary:
      'Paged, filtered read of one security audit log (issue #871), newest first, gated on logs:read. `source` selects the log (secret | permission | serviceAccount). Optional filters: action (validated against the source enum), actorId (a human uuid), serviceAccountId, date-range from/to, and — for the secret source only — vaultId/itemId (the per-vault / per-item timeline). Secret rows resolve vault/item to METADATA display names ONLY (INV-10) — never a value.',
  })
  @ApiQuery({
    name: 'source',
    required: true,
    enum: AUDIT_LOG_SOURCES,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size (1-200). Default 50.',
  })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'action',
    required: false,
    type: String,
    description: `One action label valid for the source. Unknown → 400. Allowed by source — ${ACTIONS_DOC}.`,
  })
  @ApiQuery({
    name: 'actorId',
    required: false,
    type: String,
    description: 'A concrete human actor uuid.',
  })
  @ApiQuery({ name: 'serviceAccountId', required: false, type: String })
  @ApiQuery({
    name: 'vaultId',
    required: false,
    type: String,
    description: 'Secret source only — the per-vault timeline.',
  })
  @ApiQuery({
    name: 'itemId',
    required: false,
    type: String,
    description: 'Secret source only — the per-item timeline.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Inclusive lower bound (ISO-8601). Closed-open [from, to).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'Exclusive upper bound (ISO-8601). Closed-open [from, to).',
  })
  @ApiOkResponse({ type: AuditLogPageDto })
  async logs(
    @Query('source') source?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('serviceAccountId') serviceAccountId?: string,
    @Query('vaultId') vaultId?: string,
    @Query('itemId') itemId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const query = this.parseQuery({
      source,
      limit,
      offset,
      page,
      action,
      actorId,
      serviceAccountId,
      vaultId,
      itemId,
      from,
      to,
    });
    return this.audit.getLogs(query);
  }

  @Get('logs/export')
  @RequirePermission('logs:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'Bulk CSV export of the WHOLE filtered range of one security audit log (issue #871), gated on logs:read. Takes the SAME filters as GET /audit/logs (minus paging) and streams EVERY matching row newest-first — not just the visible page. Cells are RFC-4180 escaped with a spreadsheet formula-injection guard. Secret rows carry metadata display names ONLY (INV-10) — there is no value column.',
  })
  @ApiQuery({ name: 'source', required: true, enum: AUDIT_LOG_SOURCES })
  @ApiQuery({ name: 'action', required: false, type: String })
  @ApiQuery({ name: 'actorId', required: false, type: String })
  @ApiQuery({ name: 'serviceAccountId', required: false, type: String })
  @ApiQuery({ name: 'vaultId', required: false, type: String })
  @ApiQuery({ name: 'itemId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiOkResponse({ description: 'The filtered audit log as CSV (text/csv).' })
  export(
    @Query('source') source?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('serviceAccountId') serviceAccountId?: string,
    @Query('vaultId') vaultId?: string,
    @Query('itemId') itemId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): StreamableFile {
    const filters = this.parseFilters({
      source,
      action,
      actorId,
      serviceAccountId,
      vaultId,
      itemId,
      from,
      to,
    });
    const filename = `lazyit-audit-${filters.source}-${new Date().toISOString().slice(0, 10)}.csv`;
    // Readable.from drains the async generator one chunk at a time → never the whole result in memory.
    return new StreamableFile(
      Readable.from(this.audit.streamLogsCsvRows(filters), {
        objectMode: false,
      }),
      {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="${filename}"`,
      },
    );
  }

  // ── parse / validate ───────────────────────────────────────────────────────────

  /** Validate a required `source` param on its own (the filters endpoint), → 400 otherwise. */
  private parseSource(source?: string): AuditLogSource {
    const result = AuditLogSourceSchema.safeParse(source);
    if (!result.success) {
      throw new BadRequestException(
        `source must be one of ${AUDIT_LOG_SOURCES.join(', ')}`,
      );
    }
    return result.data;
  }

  /**
   * Parse + validate the full paged query. The global ZodValidationPipe only validates `@Body()`, so
   * the raw `@Query` strings are otherwise unchecked — a missing/unknown source, a bad limit, an action
   * not valid for the source, a secret-only filter on another source, or a non-ISO date is a clean 400.
   */
  private parseQuery(raw: Record<string, string | undefined>): AuditLogQuery {
    const result = AuditLogQuerySchema.safeParse(raw);
    if (!result.success) {
      throw new BadRequestException(this.invalidMessage(result.error.message));
    }
    return result.data;
  }

  /** Same validation as {@link parseQuery} but for the export (no paging fields). */
  private parseFilters(
    raw: Record<string, string | undefined>,
  ): AuditLogFilters {
    const result = AuditLogFiltersSchema.safeParse(raw);
    if (!result.success) {
      throw new BadRequestException(this.invalidMessage(result.error.message));
    }
    return result.data;
  }

  private invalidMessage(detail: string): string {
    return `Invalid audit query: source must be one of ${AUDIT_LOG_SOURCES.join(', ')}; action must be valid for the source (${ACTIONS_DOC}); actorId a uuid; vaultId/itemId only on source "secret"; from/to ISO-8601 datetimes; limit 1-200. (${detail})`;
  }
}
