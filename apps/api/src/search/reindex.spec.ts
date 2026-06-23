import { reindexIndex, REINDEX_BATCH_SIZE, type ReindexClient } from './reindex';
import type { SearchDocument } from './search.documents';

// A fake Meilisearch client recording the operations reindexIndex performs, so we can assert the
// authoritative-rebuild sequence (ensure live index → build temp → swap → drop temp) and that the
// temp index — not the live one — receives the documents (the live index is only ever swapped).

type Op =
  | { kind: 'createIndex'; uid: string }
  | { kind: 'addDocuments'; uid: string; ids: string[] }
  | { kind: 'updateFilterableAttributes'; uid: string; attributes: string[] }
  | { kind: 'swap'; indexes: [string, string]; params: { indexes: [string, string] } }
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
        // The temp uid now carries a per-run suffix (`..._${runId}`, #464), so match on
        // substring rather than `endsWith` to single out the live index.
        if (opts.liveAlreadyExists && !uid.includes('__reindex_tmp')) {
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
      updateFilterableAttributes: (attributes: string[]) =>
        task(() => {
          ops.push({ kind: 'updateFilterableAttributes', uid, attributes });
        }),
    }),
    swapIndexes: (params) =>
      task(() => {
        // Record the full swap param so a test can assert the exact wire shape — i.e. that ONLY
        // `indexes` is sent and the `rename` field (rejected by Meili v1.12.3) is absent (#479).
        ops.push({
          kind: 'swap',
          indexes: params[0].indexes,
          params: params[0],
        });
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
  // An injected, fixed run token makes the per-run temp uid (#464) deterministic and assertable.
  const RUN = 'run-fixed';
  const TEMP = `users__reindex_tmp_${RUN}`;

  it('builds a fresh temp index, swaps it into place, then drops the temp index', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', docs('u1', 'u2'), RUN);

    // No leading deleteIndexIfExists: with a run-unique temp uid there is no shared leftover to
    // drop before creating (a prior run's temp had a different uid) — #464.
    expect(ops).toEqual([
      { kind: 'createIndex', uid: 'users' }, // ensure live index exists (first-deploy safe)
      { kind: 'createIndex', uid: TEMP }, // fresh, run-unique temp
      { kind: 'addDocuments', uid: TEMP, ids: ['u1', 'u2'] }, // live set into temp
      {
        kind: 'swap',
        indexes: ['users', TEMP],
        params: { indexes: ['users', TEMP] },
      }, // atomic, zero-downtime
      { kind: 'deleteIndexIfExists', uid: TEMP }, // dispose this run's own temp (now stale docs)
    ]);
  });

  // #479: the pinned Meilisearch server (v1.12.3) rejects the newer `rename` field on /swap-indexes
  // ("Unknown field `rename` inside `[0]`"). The swap must send ONLY `indexes` so it works on v1.12.x;
  // `rename: false` is the swap default anyway, so omitting it preserves swap-don't-rename behaviour.
  it('swaps with ONLY the `indexes` field — never the v1.12.3-unsupported `rename` (#479)', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', docs('u1'), RUN);

    const swap = ops.find(
      (op): op is Extract<Op, { kind: 'swap' }> => op.kind === 'swap',
    );
    expect(swap).toBeDefined();
    // The exact wire payload: the two-index swap and nothing else (no `rename` key).
    expect(swap?.params).toEqual({ indexes: ['users', TEMP] });
    expect(swap?.params).not.toHaveProperty('rename');
  });

  it('derives the temp uid from a per-run token: `${index}__reindex_tmp_${runId}`', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'assets', docs('a1'), 'abc123');

    const created = ops.filter(
      (op): op is Extract<Op, { kind: 'createIndex' }> =>
        op.kind === 'createIndex',
    );
    // The live index plus exactly one run-unique temp index.
    expect(created.map((op) => op.uid)).toEqual([
      'assets',
      'assets__reindex_tmp_abc123',
    ]);
  });

  it('defaults runId to a fresh unique token when none is injected', async () => {
    const { client: c1, ops: ops1 } = fakeClient();
    const { client: c2, ops: ops2 } = fakeClient();

    await reindexIndex(c1, 'users', docs('u1'));
    await reindexIndex(c2, 'users', docs('u1'));

    const tempOf = (ops: Op[]): string => {
      const create = ops.find(
        (op): op is Extract<Op, { kind: 'createIndex' }> =>
          op.kind === 'createIndex' && op.uid !== 'users',
      );
      if (create === undefined) throw new Error('no temp index created');
      return create.uid;
    };

    const temp1 = tempOf(ops1);
    const temp2 = tempOf(ops2);
    expect(temp1).toMatch(/^users__reindex_tmp_.+/);
    expect(temp2).toMatch(/^users__reindex_tmp_.+/);
    // Two un-seeded runs must NOT collide on the same temp uid.
    expect(temp1).not.toBe(temp2);
  });

  it('declares categoryId filterable on the ARTICLES temp index before the swap (ADR-0060 §5)', async () => {
    const { client, ops } = fakeClient();
    const ARTICLES_TEMP = `articles__reindex_tmp_${RUN}`;

    await reindexIndex(client, 'articles', docs('art1'), RUN);

    const filterableOp = ops.find(
      (op) => op.kind === 'updateFilterableAttributes',
    );
    expect(filterableOp).toEqual({
      kind: 'updateFilterableAttributes',
      uid: ARTICLES_TEMP,
      attributes: ['categoryId'],
    });
    // Settings are applied on the TEMP index, and BEFORE its docs are added and BEFORE the swap.
    const filterableIdx = ops.findIndex(
      (op) => op.kind === 'updateFilterableAttributes',
    );
    const addIdx = ops.findIndex((op) => op.kind === 'addDocuments');
    const swapIdx = ops.findIndex((op) => op.kind === 'swap');
    expect(filterableIdx).toBeLessThan(addIdx);
    expect(filterableIdx).toBeLessThan(swapIdx);
  });

  it('declares kind/status/state filterable on the INFRA temp index before the swap (ADR-0070 v1)', async () => {
    const { client, ops } = fakeClient();
    const INFRA_TEMP = `infra__reindex_tmp_${RUN}`;

    await reindexIndex(client, 'infra', docs('n1'), RUN);

    const filterableOp = ops.find(
      (op) => op.kind === 'updateFilterableAttributes',
    );
    expect(filterableOp).toEqual({
      kind: 'updateFilterableAttributes',
      uid: INFRA_TEMP,
      attributes: ['kind', 'status', 'state'],
    });
    const filterableIdx = ops.findIndex(
      (op) => op.kind === 'updateFilterableAttributes',
    );
    const addIdx = ops.findIndex((op) => op.kind === 'addDocuments');
    const swapIdx = ops.findIndex((op) => op.kind === 'swap');
    expect(filterableIdx).toBeLessThan(addIdx);
    expect(filterableIdx).toBeLessThan(swapIdx);
  });

  it('does NOT set filterable attributes on an index that declares none (users)', async () => {
    const { client, ops } = fakeClient();
    await reindexIndex(client, 'users', docs('u1'));
    expect(ops.some((op) => op.kind === 'updateFilterableAttributes')).toBe(
      false,
    );
  });

  it('adds documents only to the temp index, never directly to the live index (ghost eviction)', async () => {
    const { client, ops } = fakeClient();

    await reindexIndex(client, 'users', docs('u1'), RUN);

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

    await expect(
      reindexIndex(client, 'users', docs('u1'), RUN),
    ).rejects.toThrow('meili add failed');
    // The failure must not leak the temp index — cleanup runs in `finally`.
    const deletes = ops.filter(
      (op): op is Extract<Op, { kind: 'deleteIndexIfExists' }> =>
        op.kind === 'deleteIndexIfExists',
    );
    // Cleanup targets only THIS run's own temp uid — never another actor's (#464).
    expect(deletes).toEqual([{ kind: 'deleteIndexIfExists', uid: TEMP }]);
    // It must NOT have swapped a half-built index into place.
    expect(ops.some((op) => op.kind === 'swap')).toBe(false);
  });

  // #464: cross-actor collision. Two actors (e.g. the hourly reconcile sweeper #383 and the boot
  // self-heal #370, or a manual `reindex:all`) can rebuild the SAME index at overlapping times.
  // With a single shared temp uid they raced on it — one deleting/promoting the other's in-progress
  // temp. The per-run uid must make their temp indexes disjoint so neither touches the other's.
  describe('concurrent rebuilds of the SAME index (cross-actor)', () => {
    it('use DISTINCT temp uids and each cleans up only its own temp', async () => {
      // One shared fake client/op-log — as if both runs hit the same Meili instance.
      const { client, ops } = fakeClient();

      // Two overlapping rebuilds of 'users' with distinct run tokens.
      await Promise.all([
        reindexIndex(client, 'users', docs('u1'), 'actorA'),
        reindexIndex(client, 'users', docs('u2'), 'actorB'),
      ]);

      const tempA = 'users__reindex_tmp_actorA';
      const tempB = 'users__reindex_tmp_actorB';
      expect(tempA).not.toBe(tempB);

      // Each run created and disposed its OWN temp index — exactly once each.
      const created = ops.filter(
        (op): op is Extract<Op, { kind: 'createIndex' }> =>
          op.kind === 'createIndex',
      );
      expect(created.filter((op) => op.uid === tempA)).toHaveLength(1);
      expect(created.filter((op) => op.uid === tempB)).toHaveLength(1);

      const deletes = ops.filter(
        (op): op is Extract<Op, { kind: 'deleteIndexIfExists' }> =>
          op.kind === 'deleteIndexIfExists',
      );
      // Every delete targets a per-run temp uid; neither run ever deletes the OTHER's temp,
      // and there is exactly one delete per run (its own cleanup) — no cross-clobber.
      expect(deletes.filter((op) => op.uid === tempA)).toHaveLength(1);
      expect(deletes.filter((op) => op.uid === tempB)).toHaveLength(1);
      expect(deletes.every((op) => op.uid === tempA || op.uid === tempB)).toBe(
        true,
      );

      // Each run swapped its own temp into the live index; never the other's half-built temp.
      const swaps = ops.filter(
        (op): op is Extract<Op, { kind: 'swap' }> => op.kind === 'swap',
      );
      expect(swaps.some((op) => op.indexes[1] === tempA)).toBe(true);
      expect(swaps.some((op) => op.indexes[1] === tempB)).toBe(true);
    });
  });
});
