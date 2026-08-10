import { describe, expect, test } from "bun:test";
import {
  MAX_INFRA_NODE_BATCH,
  combineInfraNodeBatchItems,
  infraNodeIdBatches,
} from "./infra-node-batches";

describe("infraNodeIdBatches", () => {
  test("deterministically resolves more than 200 unique ids in bounded batches", () => {
    const ids = Array.from(
      { length: MAX_INFRA_NODE_BATCH * 2 + 1 },
      (_, index) => `node-${String(index).padStart(4, "0")}`,
    ).reverse();

    const batches = infraNodeIdBatches([...ids, ids[0]!, ids[1]!]);

    expect(batches.map((batch) => batch.length)).toEqual([
      MAX_INFRA_NODE_BATCH,
      MAX_INFRA_NODE_BATCH,
      1,
    ]);
    expect(batches.every((batch) => batch.length <= MAX_INFRA_NODE_BATCH)).toBe(true);
    expect(batches.flat()).toEqual([...ids].sort());
  });

  test("an empty resolver set makes no request batch", () => {
    expect(infraNodeIdBatches([])).toEqual([]);
  });
});

test("combineInfraNodeBatchItems preserves labels from every resolved page", () => {
  const pages = infraNodeIdBatches(
    Array.from(
      { length: MAX_INFRA_NODE_BATCH + 2 },
      (_, index) => `node-${String(index).padStart(4, "0")}`,
    ),
  ).map((batch) => ({
    items: batch.map((id) => ({ id, label: `Label for ${id}` })),
  }));

  const combined = combineInfraNodeBatchItems(pages);

  expect(combined).toHaveLength(MAX_INFRA_NODE_BATCH + 2);
  expect(combined[0]).toEqual({
    id: "node-0000",
    label: "Label for node-0000",
  });
  expect(combined.at(-1)).toEqual({
    id: `node-${String(MAX_INFRA_NODE_BATCH + 1).padStart(4, "0")}`,
    label: `Label for node-${String(MAX_INFRA_NODE_BATCH + 1).padStart(4, "0")}`,
  });
});
