import type { AiMessagePart, AiToolInvocationStatus } from "@lazyit/shared";
import type { ChatMessage } from "./stream-reducer";
import { groupMessageParts, type ToolPart } from "./tool-groups";
import { plainText } from "./untrusted-text";
import { webSourceLinks } from "./web-sources";

/**
 * `/copy` (issue #1372): the conversation as Markdown, for the clipboard. Pure — every localized word
 * comes from {@link TranscriptLabels}, so the copy reads in the user's language. Tool lines are collapsed
 * the way the chat shows them; `<untrusted_content>` wrappers are removed (they are not for people).
 */

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;
type NoticePart = Extract<AiMessagePart, { type: "notice" }>;
type InputPart = Extract<AiMessagePart, { type: "input" }>;

export interface TranscriptLabels {
  you: string;
  assistant: string;
  /** "Done: User search" for a (possibly collapsed) run of the same tool; `count` ≥ 1. */
  tool: (part: ToolPart, count: number) => string;
  /**
   * The approval card as lines: its title/state line, then the action and the field rows. `callStatus`
   * is the execution status of the same call, once approved (from its tool line).
   */
  approval: (part: ApprovalPart, callStatus: AiToolInvocationStatus | undefined) => string[];
  notice: (part: NoticePart) => string;
  /** An input form (#1388) as lines: its title/state line, the form's title, then the answer if any. */
  input: (part: InputPart) => string[];
  /** The heading of the web search sources under a message (#1389). */
  sources: string;
  /** A part this build cannot show. */
  unsupported: string;
}

function quote(lines: readonly string[]): string {
  return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

function assistantBlocks(
  parts: readonly AiMessagePart[],
  labels: TranscriptLabels,
  callStatus: ReadonlyMap<string, AiToolInvocationStatus>,
): string[] {
  const blocks: string[] = [];
  let toolLines: string[] = [];
  const flushTools = () => {
    if (toolLines.length > 0) blocks.push(toolLines.join("\n"));
    toolLines = [];
  };
  for (const item of groupMessageParts(parts)) {
    if (item.kind === "tools") {
      toolLines.push(`- ${labels.tool(item.parts[0]!, item.parts.length)}`);
      continue;
    }
    flushTools();
    const part = item.part;
    switch (part.type) {
      case "text": {
        const text = plainText(part.text).trim();
        if (text) blocks.push(text);
        break;
      }
      case "approval":
        blocks.push(quote(labels.approval(part, callStatus.get(part.request.toolCallId))));
        break;
      case "notice":
        blocks.push(quote([labels.notice(part)]));
        break;
      case "input":
        blocks.push(quote(labels.input(part)));
        break;
      case "sources": {
        // Plain text: the title is other-authored, so it is never written as Markdown link text.
        const lines = webSourceLinks(part.sources).map(
          (link) => `- ${plainText(link.label).replace(/[[\]<>`*_]/g, "")} — <${link.href}>`,
        );
        if (lines.length > 0) blocks.push([`**${labels.sources}**`, ...lines].join("\n"));
        break;
      }
      default:
        blocks.push(`_${labels.unsupported}_`);
    }
  }
  flushTools();
  return blocks;
}

/** The whole conversation as Markdown; an empty conversation is the empty string. */
export function conversationToMarkdown(
  messages: readonly ChatMessage[],
  labels: TranscriptLabels,
): string {
  const callStatus = new Map<string, AiToolInvocationStatus>();
  for (const m of messages) for (const p of m.parts) if (p.type === "tool") callStatus.set(p.toolCallId, p.status);

  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      if (text) sections.push(`### ${labels.you}\n\n${text}`);
      continue;
    }
    const blocks = assistantBlocks(message.parts, labels, callStatus);
    if (blocks.length > 0) sections.push([`### ${labels.assistant}`, ...blocks].join("\n\n"));
  }
  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}
