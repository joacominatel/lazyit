import { Readable } from 'node:stream';
import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import type { DataExportFormat, DataExportResource } from '@lazyit/shared';
import type { Response } from 'express';
import type { Principal } from '../../auth/principal';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../actor.service';
import { provenanceStampLine } from '../export-provenance';
import { assertWithinCap } from './export-cap';
import type { ExportColumn } from './export-column';
import { ExportLimiter, exportLimiterKey } from './export-limiter';
import { keysetBatches, type KeysetCursor } from './keyset';
import { streamCsv } from './stream-csv';
import { streamXlsx, XLSX_CONTENT_TYPE } from './stream-xlsx';

export type ExportFilters = Record<string, unknown>;

export interface ExportRecord {
  principal: Principal;
  resource: DataExportResource;
  filters: ExportFilters;
  rowCount: number;
}

export interface CsvExportSpec<T extends KeysetCursor> {
  resource: DataExportResource;
  principal: Principal;
  /** The route's `@Res({ passthrough: true })`: a client disconnect ends the stream and frees the slot. */
  response: Response;
  /** The parsed list filters, recorded on the audit row after {@link sanitizeExportFilters}. */
  filters: ExportFilters;
  /** `count(where)` over the same `where` the batches read. */
  count: () => Promise<number>;
  /** One batch of the list's own `where`, through {@link keysetWhere} and {@link keysetOrderBy}. */
  fetchBatch: (
    after: KeysetCursor<T['id']> | null,
    take: number,
  ) => Promise<T[]>;
  /** Already gated for this principal. */
  columns: readonly ExportColumn<T>[];
  /** `lazyit-<name>-YYYY-MM-DD.<csv|xlsx>`; also the XLSX sheet name. */
  filename: string;
  /** The `# lazyit` provenance line, only for a CSV an importer reads back (assets). Never in XLSX. */
  stamp?: boolean;
}

/** A {@link CsvExportSpec} plus the file format; `xlsx` only on a route that opted in (ADR-0103 §11). */
export interface ExportFileSpec<T extends KeysetCursor> extends CsvExportSpec<T> {
  format: DataExportFormat;
}

const MAX_FILTER_STRING = 200;
const MAX_FILTER_ARRAY = 50;
const FILTER_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type FilterScalar = string | number | boolean;

function sanitizeScalar(value: unknown): FilterScalar | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    return value === '' ? undefined : value.slice(0, MAX_FILTER_STRING);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') return value;
  return undefined;
}

/** Flat JSON of scalars and scalar arrays; nested objects, empty values and odd keys are dropped. */
export function sanitizeExportFilters(
  filters: ExportFilters,
): Record<string, FilterScalar | FilterScalar[]> {
  const out: Record<string, FilterScalar | FilterScalar[]> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!FILTER_KEY.test(key)) continue;
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_FILTER_ARRAY)
        .map(sanitizeScalar)
        .filter((v): v is FilterScalar => v !== undefined);
      if (items.length > 0) out[key] = items;
      continue;
    }
    const scalar = sanitizeScalar(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  return out;
}

/** The one server-side export path (ADR-0103): limiter, cap, audit row, then a keyset CSV or XLSX stream. */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly limiter: ExportLimiter,
  ) {}

  /** Append the immutable audit row of one export. */
  async recordExport(entry: ExportRecord): Promise<void> {
    const actor = this.actors.resolveActor(entry.principal);
    await this.prisma.dataExportLog.create({
      data: {
        actorId: actor.userId ?? null,
        serviceAccountId: actor.serviceAccountId ?? null,
        resource: entry.resource,
        filters: sanitizeExportFilters(entry.filters),
        rowCount: entry.rowCount,
      },
    });
  }

  async exportCsv<T extends KeysetCursor>(
    spec: CsvExportSpec<T>,
  ): Promise<StreamableFile> {
    return this.exportFile({ ...spec, format: 'csv' });
  }

  /** Limiter, cap, audit row, then the keyset stream as a CSV or a one-sheet XLSX workbook. */
  async exportFile<T extends KeysetCursor>(
    spec: ExportFileSpec<T>,
  ): Promise<StreamableFile> {
    const xlsx = spec.format === 'xlsx';
    const release = this.limiter.acquire(exportLimiterKey(spec.principal));
    try {
      const rowCount = await spec.count();
      assertWithinCap(rowCount);
      await this.recordExport({
        principal: spec.principal,
        resource: spec.resource,
        // No migration: the format rides in the filters JSON, and its absence means CSV.
        filters: xlsx ? { ...spec.filters, format: 'xlsx' } : spec.filters,
        rowCount,
      });
    } catch (err) {
      release();
      throw err;
    }

    const batches = keysetBatches(spec.fetchBatch);
    const body = xlsx
      ? streamXlsx({
          columns: spec.columns,
          batches,
          sheetName: spec.filename,
        })
      : Readable.from(
          streamCsv({
            columns: spec.columns,
            batches,
            stamp: spec.stamp ? provenanceStampLine() : undefined,
          }),
          { objectMode: false },
        );
    body.once('close', release);
    // A client gone during the count already fired its close.
    if (spec.response.destroyed) body.destroy();
    else spec.response.once('close', () => body.destroy());

    const date = new Date().toISOString().slice(0, 10);
    const name = `lazyit-${spec.filename}-${date}.${xlsx ? 'xlsx' : 'csv'}`;
    // Nest's default ends a started response cleanly: a truncated file would look complete.
    return new StreamableFile(body, {
      type: xlsx ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${name}"`,
    }).setErrorHandler((err) => {
      this.logger.error(
        `${spec.resource} export failed mid-stream: ${err.message}`,
        err.stack,
      );
      spec.response.destroy(err);
    });
  }
}
