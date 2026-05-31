import { reindexIndex, REINDEX_BATCH_SIZE, type ReindexClient } from './reindex';
import type { SearchDocument } from './search.documents';

// A fake Meilisearch client recording the operations reindexIndex performs, so we can assert the
// authoritative-rebuild sequence (ensure live index → build temp → swap → drop temp) and that the
// temp index — not the live one — receives the documents (the live index is only ever swapped).

type Op =
  | { kind: 'createIndex'; uid: string }
  | { kind: 'addDocuments'; uid: string; ids: string[] }
  | { kind: 'swap'; indexes: [string, string] }
  | { kind: 'deleteIndexIfExists'; uid: string };

interface FakeOptions {
  /** Make createIndex(liveUid) fail with index_already_exists (the index already exists path). */
  liveAlreadyExists?: boolean;
  /** Throw from the temp index's addDocuments waitTask to assert failures propagate. */
  failAddDocuments?: boolean;
}

function fakeClient(opts: FakeOptions = {}): {
  client: ReindexClient;
  ops: Op[];
} {
  const ops: Op[] = [];
  const task = (run?: () => void): { waitTask: () => Promise<unknown> } => ({
    waitTask: async () => {
      if (run) run();
      return { status: 'succeeded' };
    },
  });

  const client: ReindexClient = {
    createIndex: (uid, _options) =>
      task(() => {
        ops.push({ kind: 'createIndex', uid });
        if (opts.liveAlreadyExists && !uid.endsWith('__reindex_tmp')) {
          throw { code: 'index_already_exists' };
        }
      }),
    index: (uid) => ({
      addDocuments: (documents: SearchDocument[], _options) =>
        task(() => {
          ops.push({
            kind: 'addDocuments',
            uid,
            ids: documents.map((d) => d.id),
          });
          if (opts.failAddDocuments) throw new Error('meili add failed');
        }),
    }),
    swapIndexes: (params) =>
      task(() => {
        ops.push({ kind: 'swap', indexes: params[0].indexes });
      }),
    deleteIndexIfExists: async (uid) => {
      ops.push({ kind: 'deleteIndexIfExists', uid });
      return true;
    },
  };
  return { client, ops };
}

const docs = (...ids: string[]): SearchDocument[] => ids.map((id) => ({ id }));

describe('reindexIndex (authoritative rebuild)', () => {
  const TEMP = 'users__reindex_tmp';

  it('builds a fresh temp index, swaps it into place, then drops the temp index', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', docs('u1', 'u2'));

    expect(ops).toEqual([
      { kind: 'createIndex', uid: 'users' }, // ensure live index exists (first-deploy safe)
      { kind: 'deleteIndexIfExists', uid: TEMP }, // drop leftover from any interrupted run
      { kind: 'createIndex', uid: TEMP }, // fresh temp
      { kind: 'addDocuments', uid: TEMP, ids: ['u1', 'u2'] }, // live set into temp
      { kind: 'swap', indexes: ['users', TEMP] }, // atomic, zero-downtime
      { kind: 'deleteIndexIfExists', uid: TEMP }, // dispose temp (now holds the stale docs)
    ]);
  });

  it('adds documents only to the temp index, never directly to the live index (ghost eviction)', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', docs('u1'));

    const adds = ops.filter((op) => op.kind === 'addDocuments');
    expect(adds).toHaveLength(1);
    expect(adds.every((op) => op.uid === TEMP)).toBe(true);
    // The only thing that touches the live index is the swap — so stale docs there are replaced
    // wholesale by the live set, evicting any ghost (soft-deleted / unpublished) document.
    expect(ops.some((op) => op.kind === 'swap' && op.indexes[0] === 'users')).toBe(
      true,
    );
  });

  it('treats an empty live set as authoritative — swaps in an empty index (no add)', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', []);

    expect(ops.some((op) => op.kind === 'addDocuments')).toBe(false);
    // Still creates+swaps the temp so the live index is emptied (every prior doc is a ghost).
    expect(ops.some((op) => op.kind === 'swap')).toBe(true);
  });

  it('tolerates the live index already existing (idempotent ensure) and still rebuilds', async () => {
    const { client, ops } = fakeClient({ liveAlreadyExists: true });

    await expect(reindexIndex(client, 'users', docs('u1'))).resolves.toBeUndefined();

    expect(ops.some((op) => op.kind === 'swap')).toBe(true);
    expect(ops.some((op) => op.kind === 'addDocuments')).toBe(true);
  });

  it('batches large document sets into REINDEX_BATCH_SIZE chunks', async () => {
    const { client, ops } = fakeClient();
    const big = docs(
      ...Array.from(
        { length: REINDEX_BATCH_SIZE + 5 },
        (_unused, i) => `u${i}`,
      ),
    );

    await reindexIndex(client, 'users', big);

    const adds = ops.filter(
      (op): op is Extract<Op, { kind: 'addDocuments' }> =>
        op.kind === 'addDocuments',
    );
    expect(adds).toHaveLength(2);
    expect(adds[0].ids).toHaveLength(REINDEX_BATCH_SIZE);
    expect(adds[1].ids).toHaveLength(5);
  });

  it('propagates a failed Meili task and still disposes the temp index (no green over a partial build)', async () => {
    const { client, ops } = fakeClient({ failAddDocuments: true });

    await expect(reindexIndex(client, 'users', docs('u1'))).rejects.toThrow(
      'meili add failed',
    );
    // The failure must not leak the temp index — cleanup runs in `finally`.
    const deletes = ops.filter((op) => op.kind === 'deleteIndexIfExists');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(deletes.some((op) => op.uid === TEMP)).toBe(true);
    // It must NOT have swapped a half-built index into place.
    expect(ops.some((op) => op.kind === 'swap')).toBe(false);
  });
});
