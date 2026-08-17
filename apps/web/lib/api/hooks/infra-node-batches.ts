import { MAX_PAGE_LIMIT } from "@lazyit/shared";

/** The API's maximum `ids` resolver batch; kept aligned with the shared page ceiling. */
export const MAX_INFRA_NODE_BATCH = MAX_PAGE_LIMIT;

/** De-duplicate, sort, and split node ids into deterministic resolver batches. */
export function infraNodeIdBatches(ids: readonly string[]): string[][] {
  const sorted = [...new Set(ids)].sort();
  const batches: string[][] = [];
  for (let index = 0; index < sorted.length; index += MAX_INFRA_NODE_BATCH) {
    batches.push(sorted.slice(index, index + MAX_INFRA_NODE_BATCH));
  }
  return batches;
}

/** Combine every resolved page while allowing batches to arrive independently. */
export function combineInfraNodeBatchItems<T>(
  pages: readonly ({ items: readonly T[] } | undefined)[],
): T[] {
  return pages.flatMap((page) => page?.items ?? []);
}
