import type { BatchResult } from "@lazyit/shared";

/**
 * Fan out a per-entity action over many ids and collapse the outcome into the same {@link BatchResult}
 * shape the real #104 batch endpoints return, so a list can toast it with {@link notifyBatchResult}.
 *
 * Used for **bulk Restore on the entities that have NO server batch endpoint** (consumables / users /
 * locations / applications expose only `POST /<resource>/:id/restore`, unlike assets and access-grants
 * which have dedicated `batch/*` routes). Each id is restored with its own request; the calls run
 * concurrently and a per-id failure is recorded as a `skipped` reason rather than aborting the rest —
 * matching the partial-success semantics of a real batch (it is NOT transactional, but the UI outcome
 * reads the same). Prefer a real `batch/*` endpoint where one exists (assets).
 */
export async function runPerIdBatch(
  ids: string[],
  action: (id: string) => Promise<unknown>,
): Promise<BatchResult> {
  const settled = await Promise.allSettled(
    ids.map((id) => action(id).then(() => id)),
  );
  const succeeded: string[] = [];
  const skipped: BatchResult["skipped"] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      succeeded.push(ids[index]);
    } else {
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : "request_failed";
      skipped.push({ id: ids[index], reason });
    }
  });
  return { requested: ids.length, succeeded, skipped };
}
