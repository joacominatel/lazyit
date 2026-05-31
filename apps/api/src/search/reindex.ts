/**
 * Authoritative, zero-downtime reindex of a single Meilisearch index (ADR-0035).
 *
 * The fire-and-forget sync ({@link SearchService}) is eventually-consistent: a dropped `remove()`
 * (Meili down, network blip) leaves a **ghost document** — a soft-deleted asset/user/location/
 * application, or an unpublished/deleted article — searchable forever. The old reindex only
 * `addDocuments` (an upsert by primary key), so it never evicted those ghosts: re-running it gave
 * operators false confidence while soft-deleted USER PII and DRAFT articles stayed queryable.
 *
 * This makes reindex a **full rebuild**: the live set (already filtered to `deletedAt: null`, and
 * articles to PUBLISHED, by the caller — the exact visibility the read path enforces) is loaded
 * into a fresh temporary index, then atomically `swapIndexes`-ped into place. The result is that the
 * live index contains *exactly* the live set — every ghost is evicted — and `/search` is never
 * served by an empty/half-built index (zero-downtime: queries always hit a fully-populated index).
 *
 * Pure-ish and framework-agnostic: it depends only on the small {@link ReindexClient} surface (a
 * structural subset of the real `Meilisearch` client) so it can be unit-tested with a fake client.
 */
import type { SearchDocument } from './search.documents';
import type { SearchIndex } from './search.service';

/** Documents are added in chunks of this size so a single payload never blows Meili's limit. */
export const REINDEX_BATCH_SIZE = 1000;

/** An enqueued Meili task whose completion can be awaited (the `EnqueuedTaskPromise` shape). */
interface AwaitableTask {
  waitTask(): Promise<unknown>;
}

/** The single index surface the rebuild needs: batched adds (each awaited to completion). */
interface ReindexIndex {
  addDocuments(
    documents: SearchDocument[],
    options: { primaryKey: 'id' },
  ): AwaitableTask;
}

/**
 * The minimal Meilisearch client surface {@link reindexIndex} depends on — a structural subset of
 * the real `Meilisearch` client, so the real client satisfies it and a fake one is trivial to mock.
 */
export interface ReindexClient {
  index(uid: string): ReindexIndex;
  createIndex(uid: string, options: { primaryKey: 'id' }): AwaitableTask;
  swapIndexes(
    params: { indexes: [string, string]; rename: boolean }[],
  ): AwaitableTask;
  deleteIndexIfExists(uid: string): Promise<boolean>;
}

/** Split `docs` into consecutive chunks of at most `size` (the last chunk may be smaller). */
function chunk<T>(docs: T[], size: number): T[][] {
  if (docs.length === 0) return [];
  const batches: T[][] = [];
  for (let i = 0; i < docs.length; i += size) {
    batches.push(docs.slice(i, i + size));
  }
  return batches;
}

/**
 * Ensure an index exists so the later `swapIndexes` has both sides to swap. `createIndex` enqueues
 * a task that *fails* (rather than the call rejecting) when the index already exists, so we await
 * the task and swallow only that benign already-exists outcome — any other failure propagates.
 */
async function ensureIndex(
  client: ReindexClient,
  uid: string,
): Promise<void> {
  try {
    await client.createIndex(uid, { primaryKey: 'id' }).waitTask();
  } catch (err) {
    if (isIndexAlreadyExists(err)) return;
    throw err;
  }
}

/** True when a Meili task/error reports the index already exists (idempotent createIndex). */
function isIndexAlreadyExists(err: unknown): boolean {
  // A failed Meili task surfaces `{ error: { code } }`; the API error surfaces `{ cause: { code } }`.
  // Match either, plus the message, so a minor client-shape change doesn't make ensureIndex brittle.
  const code = extractCode(err);
  if (code === 'index_already_exists') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('index_already_exists');
}

function extractCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as { code?: unknown; error?: unknown; cause?: unknown };
  if (typeof record.code === 'string') return record.code;
  const nested = (record.error ?? record.cause) as
    | { code?: unknown }
    | undefined;
  return nested && typeof nested.code === 'string' ? nested.code : undefined;
}

/**
 * Authoritatively rebuild one index from its full live `docs` set, zero-downtime via index swap.
 *
 * Steps: ensure the live index exists (first-deploy safe) → drop any leftover temp index from an
 * interrupted run → create a fresh temp index → add `docs` in batches (awaiting each task so a
 * failure is loud, not silently "enqueued") → atomically swap the temp index with the live one →
 * delete the temp index (which, post-swap, now holds the stale documents).
 *
 * Throws if any Meili task fails, so the caller can exit non-zero — an operator must never see a
 * green "done" over a partial rebuild.
 */
export async function reindexIndex(
  client: ReindexClient,
  index: SearchIndex,
  docs: SearchDocument[],
): Promise<void> {
  // A deterministic temp uid (no timestamp) keeps it predictable and self-cleaning across reruns;
  // we drop any stale leftover before (re)creating it.
  const tempUid = `${index}__reindex_tmp`;

  await ensureIndex(client, index);
  await client.deleteIndexIfExists(tempUid);
  try {
    await client.createIndex(tempUid, { primaryKey: 'id' }).waitTask();

    for (const batch of chunk(docs, REINDEX_BATCH_SIZE)) {
      await client
        .index(tempUid)
        .addDocuments(batch, { primaryKey: 'id' })
        .waitTask();
    }

    // Atomic swap: queries against `index` see the old, complete data right up to the swap, then the
    // freshly-built data — never an empty or half-built index.
    await client
      .swapIndexes([{ indexes: [index, tempUid], rename: false }])
      .waitTask();
  } finally {
    // After a successful swap the temp index holds the *stale* docs; after a failure it holds a
    // partial build. Either way it is disposable — best-effort cleanup, never mask the real error.
    await client.deleteIndexIfExists(tempUid).catch(() => undefined);
  }
}
