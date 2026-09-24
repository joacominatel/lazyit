import { describe, expect, test } from "bun:test";
import type { AiMessagePart } from "@lazyit/shared";
import { groupMessageParts } from "./tool-groups";

const tool = (
  id: string,
  name: string,
  status: "SUCCEEDED" | "FAILED" = "SUCCEEDED",
  cls: "read" | "write" = "read",
): AiMessagePart => ({ type: "tool", toolCallId: id, name, class: cls, status });

const shape = (parts: AiMessagePart[]) =>
  groupMessageParts(parts).map((item) =>
    item.kind === "tools" ? `${(item.parts[0] as { name: string }).name}×${item.parts.length}@${item.index}` : `${item.part.type}@${item.index}`,
  );

describe("groupMessageParts", () => {
  test("merges consecutive identical read calls into one line", () => {
    expect(
      shape([tool("1", "user_search"), tool("2", "user_search"), tool("3", "user_search"), tool("4", "asset_search")]),
    ).toEqual(["user_search×3@0", "asset_search×1@3"]);
  });

  test("text in between, a different status or a write breaks the run", () => {
    expect(
      shape([
        tool("1", "user_search"),
        { type: "text", text: "…" },
        tool("2", "user_search"),
        tool("3", "user_search", "FAILED"),
        tool("4", "asset_update", "SUCCEEDED", "write"),
        tool("5", "asset_update", "SUCCEEDED", "write"),
      ]),
    ).toEqual([
      "user_search×1@0",
      "text@1",
      "user_search×1@2",
      "user_search×1@3",
      "asset_update×1@4",
      "asset_update×1@5",
    ]);
  });

  test("keeps every other part, in order", () => {
    expect(shape([{ type: "text", text: "a" }, { type: "notice", error: { code: "X", message: "" } }])).toEqual([
      "text@0",
      "notice@1",
    ]);
  });
});
