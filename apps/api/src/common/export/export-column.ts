import { csvCell, type CsvCellKind } from '@lazyit/shared';

export type ExportCellValue =
  string | number | bigint | Date | null | undefined;

// An allowlist entry mapped from the list projection, never the model; `money` reads minor units (ADR-0100).
export interface ExportColumn<T> {
  header: string;
  kind: CsvCellKind;
  value: (row: T) => ExportCellValue;
}

function moneyCell(minor: number | bigint): string {
  const n = BigInt(minor);
  const abs = n < 0n ? -n : n;
  const cents = abs % 100n;
  const amount =
    cents === 0n
      ? `${abs / 100n}`
      : `${abs / 100n}.${cents.toString().padStart(2, '0')}`;
  return n < 0n ? `-${amount}` : amount;
}

function formatCell(value: ExportCellValue, kind: CsvCellKind): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (kind === 'money' && typeof value !== 'string') return moneyCell(value);
  return String(value);
}

export function csvHeaderLine<T>(columns: readonly ExportColumn<T>[]): string {
  return columns.map((c) => csvCell(c.header, 'text')).join(',');
}

export function csvRowLine<T>(
  columns: readonly ExportColumn<T>[],
  row: T,
): string {
  return columns
    .map((c) => csvCell(formatCell(c.value(row), c.kind), c.kind))
    .join(',');
}
