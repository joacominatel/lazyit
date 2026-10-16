import { Readable } from 'node:stream';
import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import type { DataExportResource } from '@lazyit/shared';
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
  fetchBatch: (after: KeysetCursor | null, take: number) => Promise<T[]>;
  /** Already gated for this principal. */
  columns: readonly ExportColumn<T>[];
  /** `lazyit-<name>-YYYY-MM-DD.csv`. */
  filename: string;
  /** The `# lazyit` provenance line, only for a file an importer reads back (assets). */
  stamp?: boolean;
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

/** The one server-side export path (ADR-0103): limiter, cap, audit row, then a keyset CSV stream. */
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
    const release = this.limiter.acquire(exportLimiterKey(spec.principal));
    try {
      const rowCount = await spec.count();
      assertWithinCap(rowCount);
      await this.recordExport({
        principal: spec.principal,
        resource: spec.resource,
        filters: spec.filters,
        rowCount,
      });
    } catch (err) {
      release();
      throw err;
    }

    const body = Readable.from(
      streamCsv({
        columns: spec.columns,
        batches: keysetBatches(spec.fetchBatch),
        stamp: spec.stamp ? provenanceStampLine() : undefined,
      }),
      { objectMode: false },
    );
    body.once('close', release);
    // A client gone during the count already fired its close.
    if (spec.response.destroyed) body.destroy();
    else spec.response.once('close', () => body.destroy());

    const date = new Date().toISOString().slice(0, 10);
    // Nest's default ends a started response cleanly: a truncated file would look complete.
    return new StreamableFile(body, {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="lazyit-${spec.filename}-${date}.csv"`,
    }).setErrorHandler((err) => {
      this.logger.error(
        `${spec.resource} export failed mid-stream: ${err.message}`,
        err.stack,
      );
      spec.response.destroy(err);
    });
  }
}
