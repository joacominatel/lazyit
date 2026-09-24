"use client";

import type { AiMessagePart } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/ai/stream-reducer";
import { groupMessageParts } from "@/lib/ai/tool-groups";
import type { DecisionResult } from "@/lib/api/hooks/use-ai-turn";
import { AiApprovalCard } from "./ai-approval-card";
import { AiAutoAppliedCard } from "./ai-auto-applied-card";
import { AiMarkdown } from "./ai-markdown";
import { AiRunNotice } from "./ai-run-notice";
import { AiToolActivity } from "./ai-tool-activity";

/**
 * Streaming text re-renders at most once per animation frame (frontend.md §5.5): the markdown parse runs
 * per frame, not per token.
 */
function useFrameThrottled(value: string, active: boolean): string {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(frame);
  }, [value, active]);
  return active ? shown : value;
}

function TextPart({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useFrameThrottled(text, streaming);
  return <AiMarkdown content={shown} />;
}

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

interface AiMessageProps {
  message: ChatMessage;
  /** Every tool line of the transcript by call id, so an approval card knows its execution status. */
  tools: ReadonlyMap<string, ToolPart>;
  navigated: readonly string[];
  onDecide: (toolCallId: string, decision: "approve" | "reject", password?: string) => Promise<DecisionResult>;
}

export function AiMessage({ message, tools, navigated, onDecide }: AiMessageProps) {
  const t = useTranslations("ai.message");

  if (message.role === "user") {
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-md bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap">
          <span className="sr-only">{t("you")}: </span>
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("assistant")}
      </p>
      {groupMessageParts(message.parts).map((item) => {
        if (item.kind === "tools") {
          // Consecutive identical read calls share one line (#1377).
          return (
            <AiToolActivity
              key={item.parts[0]!.toolCallId}
              parts={item.parts}
              navigated={item.parts.some((p) => navigated.includes(p.toolCallId))}
            />
          );
        }
        const { part, index } = item;
        const key = `${message.id}-${index}`;
        switch (part.type) {
          case "text":
            return (
              <TextPart
                key={key}
                text={part.text}
                streaming={message.streaming === true && index === message.parts.length - 1}
              />
            );
          case "approval": {
            const tool = tools.get(part.request.toolCallId);
            if (part.auto === true) {
              return (
                <AiAutoAppliedCard
                  key={`approval-${part.request.toolCallId}`}
                  part={part}
                  callStatus={tool?.status}
                  failureMessage={tool?.result?.error?.message}
                />
              );
            }
            return (
              <AiApprovalCard
                key={`approval-${part.request.toolCallId}`}
                part={part}
                callStatus={tool?.status}
                failureMessage={tool?.result?.error?.message}
                onDecide={onDecide}
              />
            );
          }
          case "notice":
            return <AiRunNotice key={key} error={part.error} />;
          default:
            return (
              <p key={key} className="text-xs text-muted-foreground italic">
                {t("unsupported")}
              </p>
            );
        }
      })}
    </div>
  );
}
