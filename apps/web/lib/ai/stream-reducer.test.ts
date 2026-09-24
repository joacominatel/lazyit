import { describe, expect, test } from "bun:test";
import type { AiConversationDetail } from "@lazyit/shared";
import { approval, ev, RUN } from "./test-fixtures";
import {
  chatReducer,
  initialChatState,
  isAwaitingApproval,
  isRunActive,
  type ChatAction,
  type ChatState,
} from "./stream-reducer";

const usage = { inputTokens: 1, outputTokens: 1 };

function started(): ChatState {
  let s = initialChatState("ckconv");
  s = chatReducer(s, { type: "userMessage", localId: "local:1", text: "hi", createdAt: "2026-09-24T10:00:00Z" });
  return chatReducer(s, { type: "runStarted", runId: RUN, status: "QUEUED" });
}

function apply(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

const at = (seq: number) => `${RUN}:${seq}`;

describe("chatReducer — streaming", () => {
  test("deltas accumulate into one streaming assistant message", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: ev("run.status", { status: "RUNNING" }) },
      { type: "event", runId: RUN, eventId: at(2), event: ev("message.delta", { messageId: "m1", text: "Hel" }) },
      { type: "event", runId: RUN, eventId: at(5), event: ev("message.delta", { messageId: "m1", text: "lo" }) },
    );
    const last = s.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(last.streaming).toBe(true);
    expect(isRunActive(s)).toBe(true);
    const done = chatReducer(s, {
      type: "event",
      runId: RUN,
      eventId: at(9),
      event: ev("message.completed", { messageId: "m1" }),
    });
    expect(done.messages.at(-1)!.streaming).toBe(false);
  });

  test("ids are compared, not counted: gaps apply, replays and older ids are ignored", () => {
    let s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(10), event: ev("message.delta", { messageId: "m1", text: "a" }) },
      { type: "event", runId: RUN, eventId: at(30), event: ev("message.delta", { messageId: "m1", text: "b" }) },
    );
    expect(s.run!.lastEventId).toBe(at(30));
    s = apply(
      s,
      { type: "event", runId: RUN, eventId: at(30), event: ev("message.delta", { messageId: "m1", text: "b" }) },
      { type: "event", runId: RUN, eventId: at(12), event: ev("message.delta", { messageId: "m1", text: "x" }) },
    );
    expect(s.messages.at(-1)!.parts).toEqual([{ type: "text", text: "ab" }]);
    expect(s.run!.lastSeq).toBe(30);
  });

  test("events of another run are ignored", () => {
    const s = chatReducer(started(), {
      type: "event",
      runId: "ckother",
      eventId: "ckother:1",
      event: ev("message.delta", { messageId: "m1", text: "nope" }),
    });
    expect(s.messages).toHaveLength(1);
  });

  test("tool call → result updates one line; mutation result keeps its refs", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: ev("message.delta", { messageId: "m1", text: "Looking" }) },
      {
        type: "event",
        runId: RUN,
        eventId: at(2),
        event: ev("tool.call", { toolCallId: "c1", name: "asset_search", kind: "read", class: "read", status: "EXECUTING" }),
      },
      {
        type: "event",
        runId: RUN,
        eventId: at(3),
        event: ev("tool.result", {
          toolCallId: "c1",
          kind: "read",
          status: "ok",
          summary: "2 assets",
          mutated: false,
          entityRefs: [{ type: "asset", id: "a1", op: "updated" }],
        }),
      },
    );
    const parts = s.messages.at(-1)!.parts;
    expect(parts).toHaveLength(2);
    const tool = parts[1]!;
    expect(tool.type === "tool" && tool.status).toBe("SUCCEEDED");
    expect(tool.type === "tool" && tool.result?.summary).toBe("2 assets");
  });

  test("run.finished stops streaming and records the error", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: ev("message.delta", { messageId: "m1", text: "x" }) },
      {
        type: "event",
        runId: RUN,
        eventId: at(2),
        event: ev("run.finished", {
          status: "FAILED",
          finishReason: null,
          usage,
          error: { code: "PROVIDER_RATE_LIMIT", message: "busy", retryAfterSec: 20 },
        }),
      },
    );
    expect(s.messages.at(-1)!.streaming).toBe(false);
    expect(s.run!.status).toBe("FAILED");
    expect(s.runError?.code).toBe("PROVIDER_RATE_LIMIT");
    expect(isRunActive(s)).toBe(false);
  });
});

describe("chatReducer — approvals", () => {
  const call = ev("tool.call", { toolCallId: "w1", name: "asset_update", kind: "mutation", class: "write", status: "AWAITING_APPROVAL" });

  test("an approval request lands right after its tool line", () => {
    const { v: _v, type: _t, ...req } = { v: 1, type: "x", ...approval("w1") };
    void _v;
    void _t;
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_required", req) },
      { type: "event", runId: RUN, eventId: at(3), event: ev("run.status", { status: "AWAITING_APPROVAL" }) },
    );
    const parts = s.messages.at(-1)!.parts;
    expect(parts.map((p) => p.type)).toEqual(["tool", "approval"]);
    expect(isAwaitingApproval(s)).toBe(true);
  });

  test("resolution and execution update the card and its call", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_required", approval("w1")) },
      { type: "event", runId: RUN, eventId: at(4), event: ev("tool.approval_resolved", { toolCallId: "w1", decision: "approved" }) },
      {
        type: "event",
        runId: RUN,
        eventId: at(7),
        event: ev("tool.result", { toolCallId: "w1", kind: "mutation", status: "ok", mutated: true, entityRefs: [] }),
      },
    );
    const [tool, card] = s.messages.at(-1)!.parts;
    expect(card!.type === "approval" && card.outcome).toBe("approved");
    expect(tool!.type === "tool" && tool.status).toBe("SUCCEEDED");
  });

  test("an automatic approval (#1376) adds an applied-automatically record after the call, never a pending card", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      {
        type: "event",
        runId: RUN,
        eventId: at(2),
        event: ev("tool.approval_resolved", {
          toolCallId: "w1",
          decision: "approved",
          auto: true,
          preview: approval("w1").preview,
        }),
      },
      {
        type: "event",
        runId: RUN,
        eventId: at(3),
        event: ev("tool.result", { toolCallId: "w1", kind: "mutation", status: "ok", mutated: true, entityRefs: [] }),
      },
    );
    const [tool, record] = s.messages.at(-1)!.parts;
    expect(tool!.type === "tool" && tool.status).toBe("SUCCEEDED");
    expect(record!.type).toBe("approval");
    if (record!.type !== "approval") return;
    expect(record.auto).toBe(true);
    expect(record.outcome).toBe("approved");
    expect(record.request.preview.target?.label).toBe("MBP-042");
    expect(record.request.untrustedSources).toEqual([]);
    expect(isAwaitingApproval(s)).toBe(false);
  });

  test("an automatic approval without a preview adds nothing; a known card is marked automatic", () => {
    const bare = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_resolved", { toolCallId: "w1", decision: "approved", auto: true }) },
    );
    expect(bare.messages.at(-1)!.parts.map((p) => p.type)).toEqual(["tool"]);

    const known = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_required", approval("w1")) },
      { type: "event", runId: RUN, eventId: at(3), event: ev("tool.approval_resolved", { toolCallId: "w1", decision: "approved", auto: true }) },
    );
    const card = known.messages.at(-1)!.parts[1]!;
    expect(card.type === "approval" && card.auto).toBe(true);
    expect(known.messages.at(-1)!.parts).toHaveLength(2);
  });

  test("a click approval is not marked automatic", () => {
    const s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_required", approval("w1")) },
      { type: "event", runId: RUN, eventId: at(3), event: ev("tool.approval_resolved", { toolCallId: "w1", decision: "approved" }) },
    );
    const card = s.messages.at(-1)!.parts[1]!;
    expect(card.type === "approval" && card.auto).toBeUndefined();
  });

  test("a snapshot re-renders a changed card (PREVIEW_CHANGED) without duplicating it", () => {
    let s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: call },
      { type: "event", runId: RUN, eventId: at(2), event: ev("tool.approval_required", approval("w1")) },
    );
    const changed = approval("w1");
    changed.preview = { ...changed.preview, warnings: ["NOTIFIES_USERS", "CRITICAL_APPLICATION"], stepUpRequired: true };
    changed.stepUpRequired = true;
    s = chatReducer(s, {
      type: "event",
      runId: RUN,
      eventId: at(2),
      event: ev("run.snapshot", { seq: 2, status: "AWAITING_APPROVAL", messages: [], pendingApprovals: [changed] }),
    });
    const cards = s.messages.flatMap((m) => m.parts).filter((p) => p.type === "approval");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.type === "approval" && cards[0].request.stepUpRequired).toBe(true);
    expect(cards[0]!.type === "approval" && cards[0].request.preview.warnings).toContain("CRITICAL_APPLICATION");
    expect(s.run!.lastSeq).toBe(2);
  });
});

describe("chatReducer — snapshot, hydrate, local messages", () => {
  test("a snapshot replaces the optimistic user message and merges by id", () => {
    let s = apply(started(), {
      type: "event",
      runId: RUN,
      eventId: at(3),
      event: ev("message.delta", { messageId: "ckconv:4", text: "par" }),
    });
    s = chatReducer(s, {
      type: "event",
      runId: RUN,
      eventId: `${RUN}:8`,
      event: ev("run.snapshot", {
        seq: 8,
        status: "RUNNING",
        messages: [
          { id: "ckconv:3", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: "2026-09-24T10:00:00.000Z" },
          { id: "ckconv:4", role: "assistant", parts: [{ type: "text", text: "partial answer" }], createdAt: "2026-09-24T10:00:01.000Z" },
        ],
        pendingApprovals: [],
      }),
    });
    expect(s.messages.map((m) => m.id)).toEqual(["ckconv:3", "ckconv:4"]);
    expect(s.messages[1]!.parts).toEqual([{ type: "text", text: "partial answer" }]);
    expect(s.run!.lastEventId).toBe(`${RUN}:8`);
    // Replays up to the snapshot's position are ignored; later events apply.
    s = apply(
      s,
      { type: "event", runId: RUN, eventId: at(8), event: ev("message.delta", { messageId: "ckconv:4", text: "!!" }) },
      { type: "event", runId: RUN, eventId: at(11), event: ev("message.delta", { messageId: "ckconv:4", text: "." }) },
    );
    expect(s.messages[1]!.parts).toEqual([{ type: "text", text: "partial answer." }]);
  });

  test("a snapshot moves a live tool line to the step the server says", () => {
    let s = apply(
      started(),
      { type: "event", runId: RUN, eventId: at(1), event: ev("message.delta", { messageId: "ckconv:2", text: "a" }) },
      {
        type: "event",
        runId: RUN,
        eventId: at(2),
        event: ev("tool.call", { toolCallId: "c9", name: "asset_get", kind: "read", class: "read", status: "EXECUTING" }),
      },
    );
    s = chatReducer(s, {
      type: "event",
      runId: RUN,
      eventId: null,
      event: ev("run.snapshot", {
        seq: 5,
        status: "RUNNING",
        messages: [
          { id: "ckconv:2", role: "assistant", parts: [{ type: "text", text: "a" }], createdAt: "2026-09-24T10:00:00.000Z" },
          {
            id: "ckconv:3",
            role: "assistant",
            parts: [{ type: "tool", toolCallId: "c9", name: "asset_get", class: "read", status: "SUCCEEDED" }],
            createdAt: "2026-09-24T10:00:02.000Z",
          },
        ],
        pendingApprovals: [],
      }),
    });
    const calls = s.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool").map(() => m.id));
    expect(calls).toEqual(["ckconv:3"]);
    expect(s.run!.lastSeq).toBe(5);
  });

  test("dropLocal removes a refused message; hydrate follows the active run", () => {
    let s = chatReducer(started(), { type: "dropLocal", localId: "local:1" });
    expect(s.messages).toHaveLength(0);
    const detail: AiConversationDetail = {
      id: "ckconv",
      title: "t",
      updatedAt: "2026-09-24T10:00:00.000Z",
      status: "awaiting-approval",
      readOnly: false,
      activeRunId: "ckrun2",
      messages: [{ id: "ckconv:1", role: "user", parts: [{ type: "text", text: "x" }], createdAt: "2026-09-24T10:00:00.000Z" }],
    };
    s = chatReducer(s, { type: "hydrate", detail });
    expect(s.run).toEqual({ id: "ckrun2", status: "AWAITING_APPROVAL", lastEventId: null, lastSeq: -1 });
    expect(s.messages).toHaveLength(1);
    s = chatReducer(s, { type: "hydrate", detail: { ...detail, activeRunId: null, status: "idle" } });
    expect(s.run).toBeNull();
  });

  test("navigated is recorded once", () => {
    let s = chatReducer(started(), { type: "navigated", toolCallId: "n1" });
    s = chatReducer(s, { type: "navigated", toolCallId: "n1" });
    expect(s.navigated).toEqual(["n1"]);
  });
});
