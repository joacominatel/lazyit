import { PassThrough, Readable, pipeline } from 'node:stream';
import JSZip from 'jszip';
import type { ExportColumn } from './export-column';
import {
  XLSX_CONTENT_TYPES,
  XLSX_ROOT_RELS,
  XLSX_STYLES,
  XLSX_WORKBOOK_RELS,
  streamSheetXml,
  xlsxWorkbook,
} from './xlsx-sheet';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface StreamXlsxOptions<T> {
  columns: readonly ExportColumn<T>[];
  batches: AsyncIterable<readonly T[]>;
  sheetName: string;
}

const ENTRY = { createFolders: false } as const;

/**
 * A one-sheet workbook streamed as it is zipped (ADR-0103 §11). `streamFiles` writes each entry with
 * a trailing data descriptor instead of holding it to learn its size and CRC, so memory stays at one
 * batch plus the deflate window whatever the row count. The returned stream is a native one: it
 * emits `close` on success, error and destroy alike, and destroying it stops the batch reads.
 */
export function streamXlsx<T>({
  columns,
  batches,
  sheetName,
}: StreamXlsxOptions<T>): Readable {
  let sheetRows: (totalRows: number) => void = () => undefined;
  const totalRows = new Promise<number>((resolve) => {
    sheetRows = resolve;
  });
  const sheet = Readable.from(
    streamSheetXml({ columns, batches, onEnd: (n) => sheetRows(n) }),
    { objectMode: false },
  );

  const zip = new JSZip();
  zip.file('[Content_Types].xml', XLSX_CONTENT_TYPES, ENTRY);
  zip.file('_rels/.rels', XLSX_ROOT_RELS, ENTRY);
  zip.file('xl/_rels/workbook.xml.rels', XLSX_WORKBOOK_RELS, ENTRY);
  zip.file('xl/styles.xml', XLSX_STYLES, ENTRY);
  zip.file('xl/worksheets/sheet1.xml', sheet, ENTRY);
  // Entries are zipped in order, so this resolves once the sheet is written.
  zip.file(
    'xl/workbook.xml',
    totalRows.then((n) => xlsxWorkbook(sheetName, columns.length, n)),
    ENTRY,
  );

  const out = new PassThrough();
  const zipped = zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }) as unknown as Readable;
  pipeline(zipped, out, () => undefined);
  // JSZip swallows a source error raised while it is paused; surface every one on the output.
  sheet.once('error', (err) => out.destroy(err));
  out.once('close', () => sheet.destroy());
  return out;
}
