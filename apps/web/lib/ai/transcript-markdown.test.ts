import { describe, expect, test } from "bun:test";
import type { AiMessagePart } from "@lazyit/shared";
import type { ChatMessage } from "./stream-reducer";
import { approval, inputRequest } from "./test-fixtures";
import { conversationToMarkdown, type TranscriptLabels } from "./transcript-markdown";

const labels: TranscriptLabels = {
  you: "You",
  assistant: "Assistant",
  tool: (part, count) => `${part.status}: ${part.name}${count > 1 ? ` ×${count}` : ""}`,
  approval: (part, callStatus) => [
    `**Change** · ${part.outcome ?? "pending"}${callStatus ? ` (${callStatus})` : ""}`,
    "Assign MBP-042.",
    "- Assignee: Juan",
  ],
  notice: (part) => `Notice ${part.error.code}`,
  input: (part) => [`**Asks** · ${part.outcome ?? "pending"}`, part.request.form.title],
  unsupported: "Can't show this",
};

const at = "2026-09-24T10:00:00.000Z";
const user = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  createdAt: at,
});
const assistant = (id: string, parts: AiMessagePart[]): ChatMessage => ({
  id,
  role: "assistant",
  parts,
  createdAt: at,
});
const read = (id: string, name = "user_search"): AiMessagePart => ({
  type: "tool",
  toolCallId: id,
  name,
  class: "read",
  status: "SUCCEEDED",
});

describe("conversationToMarkdown", () => {
  test("an empty conversation copies nothing", () => {
    expect(conversationToMarkdown([], labels)).toBe("");
    expect(conversationToMarkdown([user("u1", "   ")], labels)).toBe("");
  });

  test("writes each turn under a heading, collapses repeated tool lines and strips untrusted wrappers", () => {
    const md = conversationToMarkdown(
      [
        user("u1", "Who has a laptop?"),
        assistant("a1", [
          read("t1"),
          read("t2"),
          read("t3"),
          read("t4", "asset_search"),
          { type: "text", text: "Ana has <untrusted_content>MBP-042</untrusted_content>." },
        ]),
      ],
      labels,
    );
    expect(md).toBe(
      [
        "### You",
        "",
        "Who has a laptop?",
        "",
        "### Assistant",
        "",
        "- SUCCEEDED: user_search ×3",
        "- SUCCEEDED: asset_search",
        "",
        "Ana has MBP-042.",
        "",
      ].join("\n"),
    );
  });

  test("quotes approval cards with their call's status, and notices; marks unknown parts", () => {
    const md = conversationToMarkdown(
      [
        assistant("a1", [
          { type: "approval", request: approval("w1"), outcome: "approved" },
          { type: "tool", toolCallId: "w1", name: "asset_update", class: "write", status: "SUCCEEDED" },
          { type: "notice", error: { code: "MAX_STEPS", message: "raw provider text" } },
          { type: "future-part" } as unknown as AiMessagePart,
        ]),
      ],
      labels,
    );
    expect(md).toContain("> **Change** · approved (SUCCEEDED)\n> Assign MBP-042.\n> - Assignee: Juan");
    expect(md).toContain("- SUCCEEDED: asset_update");
    expect(md).toContain("> Notice MAX_STEPS");
    expect(md).not.toContain("raw provider text");
    expect(md).toContain("_Can't show this_");
  });
});

describe("conversationToMarkdown — input forms (#1388)", () => {
  test("an input card is quoted with its state and title, never 'unsupported'", () => {
    const md = conversationToMarkdown(
      [assistant("a1", [{ type: "input", request: inputRequest("tc"), outcome: "skipped" }])],
      labels,
    );
    expect(md).toContain("> **Asks** · skipped");
    expect(md).toContain("> Details for the new laptops");
    expect(md).not.toContain("Can't show this");
  });
});
