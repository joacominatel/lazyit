import { describe, expect, test } from "bun:test";
import {
  AI_ACTION_LOG_EVENTS,
  AI_RUN_ACTIVE_STATUSES,
  AI_RUN_STATUSES,
  AI_RUN_TERMINAL_STATUSES,
  AI_RUN_WAITING_STATUSES,
  AI_TOOL_INVOCATION_STATUSES,
  AiApprovalDecisionSchema,
  AiInputFormSchema,
  AiInputSubmissionSchema,
  checkAiInputAnswer,
  type AiInputForm,
  AiConversationModelIdSchema,
  AiMessagePartSchema,
  AiRunEventSchema,
  CreateAiConversationSchema,
  CreateAiRunSchema,
  SendAiMessageSchema,
  UpdateAiConversationSchema,
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

/** A form the assistant asked the user to fill (#1388). */
const FORM: AiInputForm = {
  title: "New laptops",
  reason: "I need the make and models to create them.",
  fields: [
    {
      key: "manufacturer",
      label: "Manufacturer",
      kind: "select",
      importance: "required",
      required: true,
      options: [
        { value: "Dell", label: "Dell" },
        { value: "Lenovo", label: "Lenovo" },
      ],
      optionsFrom: "manufacturers",
    },
    { key: "arrival", label: "Arrival", kind: "date", importance: "recommended", required: false },
    {
      key: "sites",
      label: "Sites",
      kind: "multiselect",
      importance: "optional",
      required: false,
      options: [
        { value: "l1", label: "HQ" },
        { value: "l2", label: "Lab" },
      ],
    },
    { key: "asset", label: "Tag them?", kind: "checkbox", importance: "optional", required: false },
  ],
  groups: [
    {
      key: "models",
      label: "Models",
      minRows: 1,
      maxRows: 3,
      fields: [
        { key: "name", label: "Model", kind: "text", importance: "required", required: true },
        {
          key: "count",
          label: "How many",
          kind: "number",
          importance: "recommended",
          required: false,
          min: 1,
          max: 100,
        },
        { key: "notes", label: "Notes", kind: "textarea", importance: "optional", required: false },
      ],
    },
  ],
};
const INPUT_REQUEST = { toolCallId: "t3", form: FORM, expiresAt: "2026-09-23T10:30:00.000Z" };

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
  { v: 1, type: "input.required", ...INPUT_REQUEST },
  { v: 1, type: "input.resolved", toolCallId: "t3", outcome: "submitted" },
  {
    v: 1,
    type: "run.snapshot",
    seq: 9,
    status: "AWAITING_INPUT",
    messages: [
      {
        id: "m2",
        role: "assistant",
        createdAt: "2026-09-23T10:00:00.000Z",
        parts: [
          {
            type: "tool",
            toolCallId: "t3",
            name: "request_input",
            class: "navigate",
            status: "AWAITING_INPUT",
          },
          { type: "input", request: INPUT_REQUEST, outcome: null },
        ],
      },
    ],
    pendingApprovals: [],
    pendingInputs: [INPUT_REQUEST],
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
        "input.required",
        "input.resolved",
        "run.snapshot",
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

describe("per-conversation settings (#1373, #1376)", () => {
  test("a user model id: listed or custom ids pass, anything that could steer a provider URL does not", () => {
    for (const id of [
      "claude-opus-5",
      "gpt-6-sol",
      "models/gemini-3.8-flash",
      "meta-llama/Llama-3.3-70B-Instruct",
      "llama3:8b",
      "my-deploy@2026-09",
    ]) {
      expect(AiConversationModelIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of [
      "",
      "../v1/files",
      "a/../b",
      "x?key=1",
      "x#frag",
      "x%2F",
      "two words",
      "/leading",
      "a".repeat(201),
    ]) {
      expect(AiConversationModelIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test("create: everything optional, strict", () => {
    expect(CreateAiConversationSchema.safeParse({}).success).toBe(true);
    expect(
      CreateAiConversationSchema.safeParse({
        model: "claude-haiku-5",
        effort: "high",
        providerOptions: null,
        autoApprove: true,
      }).success,
    ).toBe(true);
    expect(CreateAiConversationSchema.safeParse({ effort: "max" }).success).toBe(false);
    expect(CreateAiConversationSchema.safeParse({ stepUp: false }).success).toBe(false);
  });

  test("update: at least one field", () => {
    expect(UpdateAiConversationSchema.safeParse({}).success).toBe(false);
    expect(UpdateAiConversationSchema.safeParse({ autoApprove: false }).success).toBe(true);
    expect(UpdateAiConversationSchema.safeParse({ effort: null }).success).toBe(true);
  });

  test("the approval resolution and the card carry an optional auto flag (additive)", () => {
    expect(
      AiRunEventSchema.safeParse({
        v: 1,
        type: "tool.approval_resolved",
        toolCallId: "call_1",
        decision: "approved",
        auto: true,
        preview,
      }).success,
    ).toBe(true);
    expect(
      AiRunEventSchema.safeParse({
        v: 1,
        type: "tool.approval_resolved",
        toolCallId: "call_1",
        decision: "approved",
      }).success,
    ).toBe(true);
  });
});

describe("Input requests (#1388)", () => {
  test("AWAITING_INPUT is an active, waiting status and an invocation status", () => {
    expect(AI_RUN_ACTIVE_STATUSES).toContain("AWAITING_INPUT");
    expect([...AI_RUN_WAITING_STATUSES]).toEqual(["AWAITING_APPROVAL", "AWAITING_INPUT"]);
    expect(AI_TOOL_INVOCATION_STATUSES).toContain("AWAITING_INPUT");
  });

  test("a snapshot from an older API (no pendingInputs) still parses", () => {
    const { pendingInputs: _omit, ...older } = EVENTS.find(
      (e) => e.type === "run.snapshot" && e.status === "AWAITING_INPUT",
    ) as Record<string, unknown>;
    expect(AiRunEventSchema.safeParse(older).success).toBe(true);
  });

  test("the form contract caps fields and rows", () => {
    expect(AiInputFormSchema.safeParse(FORM).success).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => ({ ...FORM.fields[1]!, key: `f${i}` }));
    expect(AiInputFormSchema.safeParse({ ...FORM, fields: many }).success).toBe(false);
    const rows = { ...FORM.groups[0]!, maxRows: 51 };
    expect(AiInputFormSchema.safeParse({ ...FORM, groups: [rows] }).success).toBe(false);
  });

  test("the submission is strict and names an action", () => {
    expect(AiInputSubmissionSchema.safeParse({ action: "skip" }).success).toBe(true);
    expect(AiInputSubmissionSchema.safeParse({ action: "submit", form: {} }).success).toBe(false);
    expect(AiInputSubmissionSchema.safeParse({ action: "approve" }).success).toBe(false);
  });

  test("accepts and normalizes a fitting answer", () => {
    const checked = checkAiInputAnswer(FORM, {
      values: { manufacturer: "Dell", arrival: "2026-10-01", sites: ["l1", "l1"], asset: true },
      groups: { models: [{ name: "  Latitude 5450 ", count: "4", notes: "" }] },
    });
    expect(checked).toEqual({
      ok: true,
      answer: {
        values: { manufacturer: "Dell", arrival: "2026-10-01", sites: ["l1"], asset: true },
        groups: { models: [{ name: "Latitude 5450", count: 4 }] },
      },
    });
  });

  test("optional and recommended fields may stay empty", () => {
    const checked = checkAiInputAnswer(FORM, {
      values: { manufacturer: "Lenovo" },
      groups: { models: [{ name: "T14" }] },
    });
    expect(checked.ok).toBe(true);
  });

  test.each([
    ["a missing required field", { values: {}, groups: { models: [{ name: "x" }] } }, "values.manufacturer", "This field is required"],
    ["an option not offered", { values: { manufacturer: "Acme" }, groups: { models: [{ name: "x" }] } }, "values.manufacturer", "Not one of the offered options"],
    ["a multiselect value not offered", { values: { manufacturer: "Dell", sites: ["l9"] }, groups: { models: [{ name: "x" }] } }, "values.sites", "Not one of the offered options"],
    ["an unknown field", { values: { manufacturer: "Dell", password: "x" }, groups: { models: [{ name: "x" }] } }, "values.password", "Unknown field"],
    ["an unknown group", { values: { manufacturer: "Dell" }, groups: { models: [{ name: "x" }], other: [] } }, "groups.other", "Unknown group"],
    ["too few rows", { values: { manufacturer: "Dell" }, groups: { models: [] } }, "groups.models", "Between 1 and 3 rows"],
    ["too many rows", { values: { manufacturer: "Dell" }, groups: { models: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] } }, "groups.models", "Between 1 and 3 rows"],
    ["a required cell left empty", { values: { manufacturer: "Dell" }, groups: { models: [{ name: " " }] } }, "groups.models.0.name", "This field is required"],
    ["a number below its minimum", { values: { manufacturer: "Dell" }, groups: { models: [{ name: "a", count: 0 }] } }, "groups.models.0.count", "At least 1"],
    ["a number that is not one", { values: { manufacturer: "Dell" }, groups: { models: [{ name: "a", count: "four" }] } }, "groups.models.0.count", "Not a valid number value"],
    ["an impossible date", { values: { manufacturer: "Dell", arrival: "2026-02-30" }, groups: { models: [{ name: "a" }] } }, "values.arrival", "Not a valid date value"],
    ["a checkbox that is not a boolean", { values: { manufacturer: "Dell", asset: "yes" }, groups: { models: [{ name: "a" }] } }, "values.asset", "Not a valid checkbox value"],
    ["an over-long text", { values: { manufacturer: "Dell" }, groups: { models: [{ name: "x".repeat(501) }] } }, "groups.models.0.name", "At most 500 characters"],
  ] as const)("refuses %s", (_name, submitted, path, message) => {
    const checked = checkAiInputAnswer(FORM, submitted as never);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues).toContainEqual({ path, message });
  });
});
