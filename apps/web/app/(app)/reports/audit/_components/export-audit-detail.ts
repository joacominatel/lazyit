/** What an `export` audit row's `detail` (`{"rowCount":…,"filters":{…}}`, ADR-0103 §7) carries. */
export interface ExportAuditDetail {
  rowCount: number;
  filters: [key: string, value: string][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `null` when the detail is not the export shape, so the caller can show it as it came. */
export function parseExportAuditDetail(detail: string | null): ExportAuditDetail | null {
  if (!detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.rowCount !== "number") return null;
  const filters = isRecord(parsed.filters) ? Object.entries(parsed.filters) : [];
  return {
    rowCount: parsed.rowCount,
    filters: filters
      // Every list export records the default slice; only `deleted=only` says something.
      .filter(([key, value]) => !(key === "deleted" && value === "active"))
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(String).join(", ") : String(value),
      ]),
  };
}

export type ExportDetailTranslate = (
  key: "rows" | "noFilters",
  values?: { count: number },
) => string;

/** "1,204 rows · q: dell · status: ACTIVE", or `null` when the detail is not the export shape. */
export function exportAuditDetailLine(
  detail: string | null,
  t: ExportDetailTranslate,
): string | null {
  const parsed = parseExportAuditDetail(detail);
  if (!parsed) return null;
  const filters =
    parsed.filters.length > 0
      ? parsed.filters.map(([key, value]) => `${key}: ${value}`)
      : [t("noFilters")];
  return [t("rows", { count: parsed.rowCount }), ...filters].join(" · ");
}
