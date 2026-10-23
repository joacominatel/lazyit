import { BadRequestException } from '@nestjs/common';
import {
  DATA_EXPORT_FORMATS,
  DataExportFormatSchema,
  type DataExportFormat,
} from '@lazyit/shared';

/** `?format=` of an export route that opted into XLSX: omitted → `csv`, anything else → 400. */
export function parseExportFormat(
  value: string | string[] | undefined,
): DataExportFormat {
  if (value === undefined) return 'csv';
  const parsed = DataExportFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(
      `Invalid format: expected one of ${DATA_EXPORT_FORMATS.join(', ')}`,
    );
  }
  return parsed.data;
}

/** The `@ApiQuery` of `?format=` on an export route that opted into XLSX. */
export const EXPORT_FORMAT_QUERY = {
  name: 'format',
  required: false,
  enum: [...DATA_EXPORT_FORMATS],
  description:
    'csv (default) or xlsx: one sheet, the same columns and headers, typed cells (numbers, money in major units, real dates in UTC), a bold frozen header with an autofilter. Any other value → 400.',
};
