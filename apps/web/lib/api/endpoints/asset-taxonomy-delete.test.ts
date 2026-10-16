import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

const calls: Call[] = [];
let failDelete: unknown = null;
const NEW_ID = "clh1new0000xyz0000000abcd";

// Same restore dance as infra.test.ts: `mock.module` is process-wide.
const CLIENT = Bun.resolveSync("../client", import.meta.dir);
const realClient = { ...(await import("../client")) };
afterAll(() => mock.module(CLIENT, () => realClient));
void mock.module(CLIENT, () => ({
  ...realClient,
  apiFetch: (path: string, init: { method?: string; body?: { name?: string } } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, ...(init.body ? { body: init.body } : {}) });
    if (method === "DELETE" && failDelete) return Promise.reject(failDelete);
    if (method === "POST") return Promise.resolve({ id: NEW_ID, name: init.body?.name });
    return Promise.resolve({});
  },
}));

const { createAssetCategory, deleteAssetCategory } = await import("./asset-categories");
const { createAssetModel, deleteAssetModel } = await import("./asset-models");
const {
  CreatedTargetDeleteError,
  replacementModelInput,
  retryAfterCreatedTarget,
  runDeleteResolution,
} = await import("../delete-resolution");

const CATEGORY = "clh1cat0000xyz0000000abcd";
const TARGET = "clh1tgt0000xyz0000000abcd";

beforeEach(() => {
  calls.length = 0;
  failDelete = null;
});

const categoryOps = {
  remove: (resolution: Parameters<typeof deleteAssetCategory>[1]) =>
    deleteAssetCategory(CATEGORY, resolution),
  create: (name: string) => createAssetCategory({ name }),
};

describe("asset category delete — one choice becomes one request", () => {
  test("a category nothing points at is deleted with no strategy", async () => {
    await deleteAssetCategory(CATEGORY);
    expect(calls).toEqual([{ path: `/asset-categories/${CATEGORY}`, method: "DELETE" }]);
  });

  test("leave without a category is a detach", async () => {
    await runDeleteResolution({ kind: "detach" }, categoryOps);
    expect(calls).toEqual([
      { path: `/asset-categories/${CATEGORY}?strategy=detach`, method: "DELETE" },
    ]);
  });

  test("move sends the picked category", async () => {
    await runDeleteResolution({ kind: "move", targetId: TARGET }, categoryOps);
    expect(calls).toEqual([
      {
        path: `/asset-categories/${CATEGORY}?strategy=move&targetId=${TARGET}`,
        method: "DELETE",
      },
    ]);
  });

  test("create posts the name, then moves the models to the new category", async () => {
    await runDeleteResolution({ kind: "create", name: " Rugged laptops " }, categoryOps);
    expect(calls).toEqual([
      { path: "/asset-categories", method: "POST", body: { name: "Rugged laptops" } },
      {
        path: `/asset-categories/${CATEGORY}?strategy=move&targetId=${NEW_ID}`,
        method: "DELETE",
      },
    ]);
  });

  test("a delete failing after the create is retried as a move, never a second create", async () => {
    failDelete = new realClient.ApiError(400, "Target category not found");
    const error = await runDeleteResolution(
      { kind: "create", name: "Rugged laptops" },
      categoryOps,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreatedTargetDeleteError);

    const retry = retryAfterCreatedTarget((error as InstanceType<typeof CreatedTargetDeleteError>).target);
    failDelete = null;
    calls.length = 0;
    await runDeleteResolution({ kind: retry.kind, targetId: retry.targetId }, categoryOps);
    expect(calls).toEqual([
      {
        path: `/asset-categories/${CATEGORY}?strategy=move&targetId=${NEW_ID}`,
        method: "DELETE",
      },
    ]);
  });
});

const MODEL = "clh1mod0000xyz0000000abcd";
const LIVE_CATEGORY = "clh1live000xyz0000000abcd";
const ARCHIVED_CATEGORY = "clh1arch000xyz0000000abcd";
const LIVE = new Set([LIVE_CATEGORY]);

function modelOps(removed: { manufacturer: string; categoryId: string | null }) {
  return {
    remove: (resolution: Parameters<typeof deleteAssetModel>[1]) =>
      deleteAssetModel(MODEL, resolution),
    create: (name: string) => createAssetModel(replacementModelInput(removed, name, LIVE)),
  };
}

describe("asset model delete — one choice becomes one request", () => {
  const ops = modelOps({ manufacturer: "Dell", categoryId: LIVE_CATEGORY });

  test("leave without a model is a detach", async () => {
    await runDeleteResolution({ kind: "detach" }, ops);
    expect(calls).toEqual([{ path: `/asset-models/${MODEL}?strategy=detach`, method: "DELETE" }]);
  });

  test("move sends the picked model", async () => {
    await runDeleteResolution({ kind: "move", targetId: TARGET }, ops);
    expect(calls).toEqual([
      { path: `/asset-models/${MODEL}?strategy=move&targetId=${TARGET}`, method: "DELETE" },
    ]);
  });

  test("create copies the manufacturer and the live category, then moves everything to it", async () => {
    await runDeleteResolution({ kind: "create", name: "Latitude 7450" }, ops);
    expect(calls).toEqual([
      {
        path: "/asset-models",
        method: "POST",
        body: { name: "Latitude 7450", manufacturer: "Dell", categoryId: LIVE_CATEGORY },
      },
      { path: `/asset-models/${MODEL}?strategy=move&targetId=${NEW_ID}`, method: "DELETE" },
    ]);
  });

  test("create leaves out an archived category, which the API would refuse", async () => {
    await runDeleteResolution(
      { kind: "create", name: "Latitude 7450" },
      modelOps({ manufacturer: "Dell", categoryId: ARCHIVED_CATEGORY }),
    );
    expect(calls[0]).toEqual({
      path: "/asset-models",
      method: "POST",
      body: { name: "Latitude 7450", manufacturer: "Dell" },
    });
  });

  test("create for a model without a category sends none", async () => {
    await runDeleteResolution(
      { kind: "create", name: "Latitude 7450" },
      modelOps({ manufacturer: "Dell", categoryId: null }),
    );
    expect(calls[0]?.body).toEqual({ name: "Latitude 7450", manufacturer: "Dell" });
  });

  test("a delete failing after the create is retried as a move, never a second create", async () => {
    failDelete = new realClient.ApiError(400, "Target model not found");
    const error = await runDeleteResolution({ kind: "create", name: "Latitude 7450" }, ops).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CreatedTargetDeleteError);

    const retry = retryAfterCreatedTarget((error as InstanceType<typeof CreatedTargetDeleteError>).target);
    failDelete = null;
    calls.length = 0;
    await runDeleteResolution({ kind: retry.kind, targetId: retry.targetId }, ops);
    expect(calls).toEqual([
      { path: `/asset-models/${MODEL}?strategy=move&targetId=${NEW_ID}`, method: "DELETE" },
    ]);
  });
});
