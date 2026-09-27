"use client";

import type { AiMessagePart } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/ai/stream-reducer";
import { planMessageParts } from "@/lib/ai/approval-pages";
import type { DecisionResult } from "@/lib/api/hooks/use-ai-turn";
import { AiApprovalCard } from "./ai-approval-card";
import { AiApprovalPager } from "./ai-approval-pager";
import { AiAutoAppliedCard } from "./ai-auto-applied-card";
import { AiInputCard, type AnswerInput } from "./ai-input-card";
import { AiMarkdown } from "./ai-markdown";
import { AiRefusedCalls } from "./ai-refused-calls";
import { AiRunNotice } from "./ai-run-notice";
import { AiToolActivity } from "./ai-tool-activity";
import { AiWebSources } from "./ai-web-sources";

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
  /** Answers an input form the assistant asked for (#1388). */
  onAnswerInput: AnswerInput;
  /** An input form's time ran out in this browser. */
  onInputExpired?: (toolCallId: string) => void;
}

export function AiMessage({
  message,
  tools,
  navigated,
  onDecide,
  onAnswerInput,
  onInputExpired,
}: AiMessageProps) {
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
      {planMessageParts(message.parts).map((item) => {
        if (item.kind === "approvals") {
          // Several changes of one step: one paged card (#1409).
          return (
            <AiApprovalPager
              key={`pager-${item.parts[0]!.request.toolCallId}`}
              parts={item.parts}
              tools={tools}
              navigated={navigated}
              onDecide={onDecide}
            />
          );
        }
        if (item.kind === "refused") {
          // Changes the server refused before proposing them: one line, not one per call (#1409).
          return <AiRefusedCalls key={`refused-${item.parts[0]!.toolCallId}`} parts={item.parts} />;
        }
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
                  failure={tool?.result?.error}
                />
              );
            }
            return (
              <AiApprovalCard
                key={`approval-${part.request.toolCallId}`}
                part={part}
                callStatus={tool?.status}
                failure={tool?.result?.error}
                onDecide={onDecide}
              />
            );
          }
          case "input":
            return (
              <AiInputCard
                key={`input-${part.request.toolCallId}`}
                part={part}
                onAnswer={onAnswerInput}
                onExpired={onInputExpired}
              />
            );
          case "notice":
            return <AiRunNotice key={key} error={part.error} />;
          case "sources":
            return <AiWebSources key={key} part={part} />;
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
