import { BadRequestException } from '@nestjs/common';
import type { ImportFormat } from './parser';

/**
 * Upload helpers for the migrator controller (ADR-0069 wave 4b, #635): the multer size cap and the
 * extension → {@link ImportFormat} detection. Mirrors the KB article-import upload helpers
 * (`articles/article-import.ts`) — same fixed-at-boot size cap pattern (SEC-001) and same
 * extension-driven dispatch — kept migrator-local so the two import paths don't couple.
 */

const DEFAULT_MAX_IMPORT_MB = 5;

/** Phase-1 accepted extensions (ADR-0069: JSON + CSV; `.xlsx` is rejected with an actionable message). */
const FORMAT_BY_EXTENSION: Record<string, ImportFormat> = {
  csv: 'csv',
  json: 'json',
};

/**
 * Max import size in MB from `MAX_IMPORT_SIZE_MB` (default 5; shared name with the article path so an
 * operator tunes one knob). Falls back to the default on a missing/invalid value.
 */
export function maxImportMb(): number {
  const raw = process.env.MAX_IMPORT_SIZE_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMPORT_MB;
}

/**
 * Max import size in BYTES — the multer `limits.fileSize` cap (SEC-001), evaluated at decoration time
 * so multer aborts an over-cap stream early instead of buffering it into the heap.
 */
export function maxImportBytes(): number {
  return Math.floor(maxImportMb() * 1024 * 1024);
}

/** Lowercased file extension without the dot (`""` if none). */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Resolve the {@link ImportFormat} from the uploaded filename's extension. Phase 1 accepts only `.csv`
 * and `.json`; `.xlsx`/`.xls` get an actionable "export to CSV UTF-8" 400 (ADR-0069 §12), and any other
 * type is a generic 400. The format is what the parse worker dispatches on — never sniffed from the
 * (untrusted) bytes here.
 */
export function detectImportFormat(filename: string): ImportFormat {
  const ext = extensionOf(filename);
  const format = FORMAT_BY_EXTENSION[ext];
  if (format) {
    return format;
  }
  if (ext === 'xlsx' || ext === 'xls') {
    throw new BadRequestException(
      'Spreadsheet files (.xlsx/.xls) are not supported. Export your sheet to CSV (UTF-8) and upload that instead.',
    );
  }
  throw new BadRequestException(
    `Unsupported file type "${ext ? '.' + ext : '(none)'}". Supported: .csv, .json.`,
  );
}
