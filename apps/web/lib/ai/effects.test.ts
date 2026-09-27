import { describe, expect, test } from "bun:test";
import { ev } from "./test-fixtures";
import { isOutsideAssistant, planEffects, planSnapshotEffects } from "./effects";

const live = { live: true, unsaved: false, alreadyApplied: false };

describe("planEffects", () => {
  test("an executed mutation invalidates; a read does not", () => {
    const mutation = ev("tool.result", { toolCallId: "c", kind: "mutation", status: "ok", mutated: true, entityRefs: [] });
    expect(planEffects(mutation, live)).toEqual({ invalidate: true, navigateTo: null });
    const read = ev("tool.result", { toolCallId: "c", kind: "read", status: "ok", mutated: false, entityRefs: [] });
    expect(planEffects(read, live)).toEqual({ invalidate: false, navigateTo: null });
  });

  test("a failed call has no effect", () => {
    const failed = ev("tool.result", {
      toolCallId: "c",
      kind: "mutation",
      status: "error",
      mutated: false,
      entityRefs: [],
      error: { code: "STALE", message: "x" },
    });
    expect(planEffects(failed, live)).toEqual({ invalidate: false, navigateTo: null });
  });

  const nav = ev("tool.result", {
    toolCallId: "n",
    kind: "navigate",
    status: "ok",
    mutated: false,
    entityRefs: [{ type: "asset", id: "a1", op: "navigate" }],
  });

  test("an explicit navigate call moves the user", () => {
    expect(planEffects(nav, live).navigateTo).toBe("/assets/a1");
  });

  test("never navigates over unsaved edits, from a replay-applied call, or off the live stream", () => {
    expect(planEffects(nav, { ...live, unsaved: true }).navigateTo).toBeNull();
    expect(planEffects(nav, { ...live, alreadyApplied: true }).navigateTo).toBeNull();
    expect(planEffects(nav, { ...live, live: false }).navigateTo).toBeNull();
  });

  test("a mutation result that points at an entity never navigates by itself", () => {
    const created = ev("tool.result", {
      toolCallId: "c",
      kind: "mutation",
      status: "ok",
      mutated: true,
      entityRefs: [{ type: "asset", id: "a1", op: "created" }],
    });
    expect(planEffects(created, live).navigateTo).toBeNull();
  });

  test("a navigate target without a page does nothing", () => {
    const toModel = ev("tool.result", {
      toolCallId: "n",
      kind: "navigate",
      status: "ok",
      mutated: false,
      entityRefs: [{ type: "assetModel", id: "m", op: "navigate" }],
    });
    expect(planEffects(toModel, live).navigateTo).toBeNull();
  });

  test("other events have no effect", () => {
    expect(planEffects(ev("run.status", { status: "RUNNING" }), live)).toEqual({ invalidate: false, navigateTo: null });
  });
});

describe("planSnapshotEffects", () => {
  const snapshot = ev("run.snapshot", {
    seq: 3,
    status: "SUCCEEDED",
    pendingApprovals: [],
    messages: [
      {
        id: "m",
        role: "assistant",
        createdAt: "2026-09-24T10:00:00.000Z",
        parts: [
          {
            type: "tool",
            toolCallId: "w1",
            name: "asset_update",
            class: "write",
            status: "SUCCEEDED",
            result: { toolCallId: "w1", kind: "mutation", status: "ok", mutated: true, entityRefs: [] },
          },
          {
            type: "tool",
            toolCallId: "r1",
            name: "asset_get",
            class: "read",
            status: "SUCCEEDED",
            result: { toolCallId: "r1", kind: "read", status: "ok", mutated: false, entityRefs: [] },
          },
        ],
      },
    ],
  });

  test("invalidates once for a mutation the stream never delivered", () => {
    expect(planSnapshotEffects(snapshot, new Set())).toEqual({ invalidate: true, callIds: ["w1"] });
    expect(planSnapshotEffects(snapshot, new Set(["w1"]))).toEqual({ invalidate: false, callIds: [] });
  });
});

describe("isOutsideAssistant", () => {
  test("matches every query except the assistant's own subtree", () => {
    expect(isOutsideAssistant({ queryKey: ["assets", "list"] })).toBe(true);
    expect(isOutsideAssistant({ queryKey: ["dashboard"] })).toBe(true);
    expect(isOutsideAssistant({ queryKey: ["ai", "status"] })).toBe(false);
    expect(isOutsideAssistant({ queryKey: ["ai", "conversations", "list"] })).toBe(false);
  });
});
