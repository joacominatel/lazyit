import type { AiMessagePart } from "@lazyit/shared";

/**
 * Collapsing repeated tool lines (issue #1377): an assistant that calls the same read tool five times in
 * a row shows ONE line — "Done: User search ×5" — instead of five identical ones. Only consecutive READ
 * calls of the same tool with the same status collapse: a write keeps its own line (it has an approval
 * card and "Open" chips), and a different status (one failed among successes) breaks the run.
 */

export type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

export type MessageItem =
  | { kind: "part"; part: AiMessagePart; index: number }
  | { kind: "tools"; parts: ToolPart[]; index: number };

function collapsible(a: ToolPart, b: ToolPart): boolean {
  return a.class === "read" && b.class === "read" && a.name === b.name && a.status === b.status;
}

/** A message's parts as render items, consecutive identical read calls merged. `index` is the first part's. */
export function groupMessageParts(parts: readonly AiMessagePart[]): MessageItem[] {
  const items: MessageItem[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "tool") {
      items.push({ kind: "part", part, index });
      return;
    }
    const last = items[items.length - 1];
    if (last?.kind === "tools" && collapsible(last.parts[last.parts.length - 1]!, part)) {
      last.parts.push(part);
      return;
    }
    items.push({ kind: "tools", parts: [part], index });
  });
  return items;
}
