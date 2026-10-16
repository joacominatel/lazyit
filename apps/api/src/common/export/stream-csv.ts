import { CSV_BOM, CSV_EOL } from '@lazyit/shared';
import { csvHeaderLine, csvRowLine, type ExportColumn } from './export-column';

export interface StreamCsvOptions<T> {
  columns: readonly ExportColumn<T>[];
  batches: AsyncIterable<readonly T[]>;
  /** A leading comment line, only where an importer consumes it (the asset `# lazyit` stamp). */
  stamp?: string;
}

/** BOM, optional stamp, header, then one chunk per batch, every line CRLF-terminated. */
export async function* streamCsv<T>({
  columns,
  batches,
  stamp,
}: StreamCsvOptions<T>): AsyncGenerator<string> {
  const stampLine = stamp === undefined ? '' : `${stamp}${CSV_EOL}`;
  yield `${CSV_BOM}${stampLine}${csvHeaderLine(columns)}${CSV_EOL}`;
  for await (const rows of batches) {
    if (rows.length === 0) continue;
    yield `${rows.map((row) => csvRowLine(columns, row)).join(CSV_EOL)}${CSV_EOL}`;
  }
}
