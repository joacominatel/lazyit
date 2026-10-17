import { describe, expect, test } from "bun:test";
import type { DeleteResolution } from "@lazyit/shared";
import { ApiError } from "./client";
import {
  CreatedTargetDeleteError,
  deleteResolutionQuery,
  isChoiceReady,
  isDeleteResolutionRequired,
  locationSubtreeIds,
  resolutionChoiceKinds,
  retryAfterCreatedTarget,
  runDeleteResolution,
} from "./delete-resolution";

const TARGET = "clh1abc0000xyz0000000abcd";

function recorder(options: { failRemove?: unknown } = {}) {
  const removed: DeleteResolution[] = [];
  const created: string[] = [];
  return {
    removed,
    created,
    ops: {
      remove: (resolution: DeleteResolution) => {
        removed.push(resolution);
        return options.failRemove ? Promise.reject(options.failRemove) : Promise.resolve();
      },
      create: (name: string) => {
        created.push(name);
        return Promise.resolve({ id: TARGET, name });
      },
    },
  };
}

describe("deleteResolutionQuery", () => {
  test("a plain delete sends no query", () => {
    expect(deleteResolutionQuery(undefined)).toBe("");
  });

  test("detach and move map to the API's strategy params", () => {
    expect(deleteResolutionQuery({ strategy: "detach" })).toBe("?strategy=detach");
    expect(deleteResolutionQuery({ strategy: "move", targetId: TARGET })).toBe(
      `?strategy=move&targetId=${TARGET}`,
    );
  });
});

describe("runDeleteResolution — one choice becomes one request", () => {
  test("leave unassigned deletes with detach and creates nothing", async () => {
    const r = recorder();
    await runDeleteResolution({ kind: "detach" }, r.ops);
    expect(r.removed).toEqual([{ strategy: "detach" }]);
    expect(r.created).toEqual([]);
  });

  test("move to an existing one deletes with move to it", async () => {
    const r = recorder();
    await runDeleteResolution({ kind: "move", targetId: TARGET }, r.ops);
    expect(r.removed).toEqual([{ strategy: "move", targetId: TARGET }]);
    expect(r.created).toEqual([]);
  });

  test("create a new one creates it first, then deletes with move to the new id", async () => {
    const r = recorder();
    await runDeleteResolution({ kind: "create", name: "  Warehouse B  " }, r.ops);
    expect(r.created).toEqual(["Warehouse B"]);
    expect(r.removed).toEqual([{ strategy: "move", targetId: TARGET }]);
  });

  test("a delete failing after the create says which target now exists", async () => {
    const r = recorder({ failRemove: new ApiError(400, "Target location not found") });
    const error = await runDeleteResolution({ kind: "create", name: "Warehouse B" }, r.ops).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CreatedTargetDeleteError);
    expect((error as CreatedTargetDeleteError).target).toEqual({ id: TARGET, name: "Warehouse B" });
    expect((error as CreatedTargetDeleteError).message).toBe("Target location not found");
  });

  test("a failing create deletes nothing", async () => {
    const r = recorder();
    const failing = { ...r.ops, create: () => Promise.reject(new ApiError(409, "Name taken")) };
    await expect(runDeleteResolution({ kind: "create", name: "Dup" }, failing)).rejects.toThrow(
      "Name taken",
    );
    expect(r.removed).toEqual([]);
  });
});

describe("after a create succeeded and its delete failed", () => {
  test("the retry is a move to the created target and 'create' is no longer offered", () => {
    const retry = retryAfterCreatedTarget({ id: TARGET, name: "Warehouse B" });
    expect(retry).toEqual({
      kind: "move",
      targetId: TARGET,
      created: { id: TARGET, name: "Warehouse B" },
    });
    expect(resolutionChoiceKinds({ canCreate: true, created: retry.created })).toEqual([
      "detach",
      "move",
    ]);
  });

  test("so the retry never creates a second target", async () => {
    const retry = retryAfterCreatedTarget({ id: TARGET, name: "Warehouse B" });
    const r = recorder();
    await runDeleteResolution({ kind: retry.kind, targetId: retry.targetId }, r.ops);
    expect(r.created).toEqual([]);
    expect(r.removed).toEqual([{ strategy: "move", targetId: TARGET }]);
  });
});

describe("resolutionChoiceKinds", () => {
  test("all three choices before anything was created", () => {
    expect(resolutionChoiceKinds({ canCreate: true, created: null })).toEqual([
      "detach",
      "move",
      "create",
    ]);
  });

  test("no 'create' without the write permission", () => {
    expect(resolutionChoiceKinds({ canCreate: false, created: null })).toEqual(["detach", "move"]);
  });
});

describe("isChoiceReady", () => {
  test("nothing picked, a move without a target and a blank name are not ready", () => {
    expect(isChoiceReady(null)).toBe(false);
    expect(isChoiceReady({ kind: "move", targetId: "" })).toBe(false);
    expect(isChoiceReady({ kind: "create", name: "   " })).toBe(false);
  });

  test("detach, a move with a target and a named create are ready", () => {
    expect(isChoiceReady({ kind: "detach" })).toBe(true);
    expect(isChoiceReady({ kind: "move", targetId: TARGET })).toBe(true);
    expect(isChoiceReady({ kind: "create", name: "New" })).toBe(true);
  });
});

describe("isDeleteResolutionRequired", () => {
  test("recognises the 409 by its code", () => {
    const body = { statusCode: 409, code: "DELETE_RESOLUTION_REQUIRED", dependents: { assets: 2 } };
    expect(isDeleteResolutionRequired(new ApiError(409, "in use", body))).toBe(true);
  });

  test("another 409, another status or a non-API error is not it", () => {
    expect(isDeleteResolutionRequired(new ApiError(409, "A record with this name exists"))).toBe(false);
    expect(
      isDeleteResolutionRequired(new ApiError(400, "x", { code: "DELETE_RESOLUTION_REQUIRED" })),
    ).toBe(false);
    expect(isDeleteResolutionRequired(new Error("Failed to fetch"))).toBe(false);
  });
});

describe("locationSubtreeIds", () => {
  const tree = [
    { id: "hq", parentId: null },
    { id: "floor1", parentId: "hq" },
    { id: "rack1", parentId: "floor1" },
    { id: "floor2", parentId: "hq" },
    { id: "remote", parentId: null },
  ];

  test("holds the location and every descendant, not its siblings or ancestors", () => {
    expect([...locationSubtreeIds(tree, "floor1")].sort()).toEqual(["floor1", "rack1"]);
    expect([...locationSubtreeIds(tree, "hq")].sort()).toEqual(["floor1", "floor2", "hq", "rack1"]);
  });

  test("survives a cycle in stale data", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect([...locationSubtreeIds(cyclic, "a")].sort()).toEqual(["a", "b"]);
  });
});
