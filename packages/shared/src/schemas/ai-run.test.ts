import { describe, expect, test } from "bun:test";
import {
  AI_ACTION_LOG_EVENTS,
  AI_RUN_ACTIVE_STATUSES,
  AI_RUN_STATUSES,
  AI_RUN_TERMINAL_STATUSES,
  AI_TOOL_INVOCATION_STATUSES,
  AiApprovalDecisionSchema,
  AiMessagePartSchema,
  AiRunEventSchema,
  CreateAiRunSchema,
  SendAiMessageSchema,
} from "./ai-run";

// Runs, approvals and the versioned run event stream (ADR-0097 decisions 4–6; synthesis §4.4, §4.6).

const preview = {
  toolName: "asset_update",
  class: "write",
  changes: [{ field: "status", after: "DEPLOYED" }],
  warnings: [],
  elevated: false,
  stepUpRequired: false,
};
const usage = { inputTokens: 1200, outputTokens: 80 };

/** One valid event of every type in the union — the covering set the parser must accept. */
const EVENTS = [
  {
    v: 1,
    type: "run.snapshot",
    seq: 7,
    status: "AWAITING_APPROVAL",
    messages: [
      {
        id: "m1",
        role: "assistant",
        createdAt: "2026-09-23T10:00:00.000Z",
        parts: [{ type: "text", text: "Here is the plan" }],
      },
    ],
    pendingApprovals: [
      {
        toolCallId: "t1",
        preview,
        elevated: false,
        stepUpRequired: false,
        untrustedSources: [],
        expiresAt: "2026-09-23T10:30:00.000Z",
      },
    ],
  },
  { v: 1, type: "run.status", status: "RUNNING" },
  { v: 1, type: "message.delta", messageId: "m1", text: "Hel" },
  { v: 1, type: "message.completed", messageId: "m1" },
  {
    v: 1,
    type: "tool.call",
    toolCallId: "t1",
    name: "asset_search",
    kind: "read",
    class: "read",
    status: "EXECUTING",
    args: { query: "laptop", limit: 20 },
  },
  {
    v: 1,
    type: "tool.approval_required",
    toolCallId: "t2",
    preview,
    elevated: false,
    stepUpRequired: false,
    untrustedSources: [],
    expiresAt: "2026-09-23T10:30:00.000Z",
  },
  { v: 1, type: "tool.approval_resolved", toolCallId: "t2", decision: "approved" },
  {
    v: 1,
    type: "tool.result",
    toolCallId: "t2",
    kind: "mutation",
    status: "ok",
    summary: "Asset updated",
    mutated: true,
    entityRefs: [{ type: "asset", id: "a1", op: "updated" }],
  },
  { v: 1, type: "step.finished", stepIndex: 0, usage },
  {
    v: 1,
    type: "run.finished",
    status: "FAILED",
    finishReason: null,
    usage,
    error: { code: "PROVIDER_RATE_LIMIT", message: "Busy", retryAfterSec: 30 },
  },
] as const;

describe("Status sets", () => {
  test("terminal and active statuses partition the run statuses", () => {
    const union = new Set<string>([...AI_RUN_TERMINAL_STATUSES, ...AI_RUN_ACTIVE_STATUSES]);
    expect(union).toEqual(new Set(AI_RUN_STATUSES));
    expect(AI_RUN_TERMINAL_STATUSES.length + AI_RUN_ACTIVE_STATUSES.length).toBe(
      AI_RUN_STATUSES.length,
    );
  });

  test("the invocation and ledger vocabularies match the synthesis", () => {
    expect(AI_TOOL_INVOCATION_STATUSES).toContain("OUTCOME_UNKNOWN");
    expect([...AI_ACTION_LOG_EVENTS]).toEqual([
      "PROPOSED",
      "APPROVED",
      "REJECTED",
      "EXPIRED",
      "CANCELLED",
      "ATTEMPTED",
      "EXECUTED",
      "FAILED",
      "DENIED",
    ]);
  });
});

describe("Run event union (v: 1)", () => {
  test.each(EVENTS.map((event) => [event.type, event] as const))("accepts %s", (_type, event) => {
    expect(AiRunEventSchema.safeParse(event).success).toBe(true);
  });

  test("covers every event type the synthesis names", () => {
    expect(EVENTS.map((event) => event.type).sort()).toEqual(
      [
        "run.snapshot",
        "run.status",
        "message.delta",
        "message.completed",
        "tool.call",
        "tool.approval_required",
        "tool.approval_resolved",
        "tool.result",
        "step.finished",
        "run.finished",
      ].sort(),
    );
  });

  test("rejects an unknown event type (the consumer skips it)", () => {
    expect(AiRunEventSchema.safeParse({ v: 1, type: "run.teleported" }).success).toBe(false);
  });

  test("rejects another stream version", () => {
    expect(AiRunEventSchema.safeParse({ v: 2, type: "run.status", status: "RUNNING" }).success).toBe(
      false,
    );
  });

  test("rejects an unknown run status", () => {
    expect(AiRunEventSchema.safeParse({ v: 1, type: "run.status", status: "PAUSED" }).success).toBe(
      false,
    );
  });

  test("tool.call args are a flat summary, never nested input", () => {
    expect(
      AiRunEventSchema.safeParse({
        v: 1,
        type: "tool.call",
        toolCallId: "t1",
        name: "asset_update",
        kind: "mutation",
        class: "write",
        status: "AWAITING_APPROVAL",
        args: { specs: { cpu: "x" } },
      }).success,
    ).toBe(false);
  });

  test("a tool.result with an unknown entity ref keeps the event and drops the ref", () => {
    const parsed = AiRunEventSchema.parse({
      v: 1,
      type: "tool.result",
      toolCallId: "t3",
      kind: "mutation",
      status: "ok",
      mutated: true,
      entityRefs: [
        { type: "asset", id: "a1", op: "updated" },
        { type: "hologram", id: "h1", op: "updated" },
      ],
    });
    expect(parsed.type === "tool.result" && parsed.entityRefs).toEqual([
      { type: "asset", id: "a1", op: "updated" },
    ]);
  });

  test("run.finished keeps an error code this build does not know (rendered generically)", () => {
    expect(
      AiRunEventSchema.safeParse({
        v: 1,
        type: "run.finished",
        status: "FAILED",
        finishReason: null,
        usage,
        error: { code: "SOMETHING_NEWER", message: "x" },
      }).success,
    ).toBe(true);
  });
});

describe("Persisted message parts (discriminated on type)", () => {
  test("accepts each part type", () => {
    const parts = [
      { type: "text", text: "Done" },
      { type: "tool", toolCallId: "t1", name: "asset_search", class: "read", status: "SUCCEEDED" },
      {
        type: "approval",
        request: {
          toolCallId: "t2",
          preview,
          elevated: false,
          stepUpRequired: false,
          untrustedSources: [],
          expiresAt: "2026-09-23T10:30:00.000Z",
        },
        outcome: null,
      },
      { type: "notice", error: { code: "CONTEXT_LIMIT", message: "Too long" } },
    ];
    for (const part of parts) {
      expect(AiMessagePartSchema.safeParse(part).success).toBe(true);
    }
  });

  test("rejects an unknown part type", () => {
    expect(AiMessagePartSchema.safeParse({ type: "image", url: "x" }).success).toBe(false);
  });
});

describe("Requests", () => {
  test("a message carries text and an optional page context; empty text is refused", () => {
    expect(
      SendAiMessageSchema.safeParse({
        text: "Who has LAP-042?",
        context: { route: "/assets/a1", entity: { type: "asset", id: "a1" } },
      }).success,
    ).toBe(true);
    expect(SendAiMessageSchema.safeParse({ text: "   " }).success).toBe(false);
  });

  test("the page context never carries page content", () => {
    expect(
      SendAiMessageSchema.safeParse({
        text: "hi",
        context: { route: "/assets/a1", content: "<html>" },
      }).success,
    ).toBe(false);
  });

  test("a headless run needs a prompt", () => {
    expect(CreateAiRunSchema.safeParse({ prompt: "Count laptops" }).success).toBe(true);
    expect(CreateAiRunSchema.safeParse({}).success).toBe(false);
  });

  test("an approval decision carries only the decision — never arguments", () => {
    expect(AiApprovalDecisionSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(
      AiApprovalDecisionSchema.safeParse({ decision: "reject", reason: "Wrong asset" }).success,
    ).toBe(true);
    expect(
      AiApprovalDecisionSchema.safeParse({ decision: "approve", input: { status: "LOST" } })
        .success,
    ).toBe(false);
    expect(AiApprovalDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });
});
