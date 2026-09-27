import type { AssetTagSchemeSummary } from "@lazyit/shared";

/**
 * The tag the asset CREATE form tells the operator a blank tag would get (ADR-0063, #1180, #1315), or
 * undefined when there is nothing honest to say: on edit (the scheme only fills a create), when the
 * scheme is off, when the summary has not resolved (or failed), or when the sequence is exhausted
 * (`nextTag` null). The tag comes from the server's skip-existing preview, never from a local render.
 */
export function autoTagHintFrom(
  summary: AssetTagSchemeSummary | undefined,
  isEdit: boolean,
): string | undefined {
  if (isEdit || !summary?.enabled) return undefined;
  return summary.nextTag ?? undefined;
}
