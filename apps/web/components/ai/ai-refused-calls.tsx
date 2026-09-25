"use client";

import type { AiMessagePart } from "@lazyit/shared";
import { ChevronRightIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { refusedDetails } from "@/lib/ai/approval-pages";
import { plainText } from "@/lib/ai/untrusted-text";
import { cn } from "@/lib/utils";
import { useToolDisplayName } from "./ai-labels";

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

/**
 * The changes the server refused before they became a proposal, as ONE line (#1409): "20 changes
 * couldn't be proposed — Show details" instead of one "Failed" line each. The details group the calls
 * by tool and reason ("Update asset ×20: Propose at most 5 changes at a time"), as plain text.
 */
export function AiRefusedCalls({ parts }: { parts: readonly ToolPart[] }) {
  const t = useTranslations("ai");
  const toolName = useToolDisplayName();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const details = refusedDetails(parts);

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
        <ExclamationCircleIcon className="size-3.5 shrink-0 text-destructive-text" aria-hidden />
        <span className="min-w-0 truncate">{t("refused.summary", { count: parts.length })}</span>
        <button
          type="button"
          className="ml-auto inline-flex min-h-6 items-center gap-0.5 rounded-sm px-1 font-sans text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
          {open ? t("tools.hideDetails") : t("tools.showDetails")}
        </button>
      </div>
      <ul id={listId} hidden={!open} className="mt-1 ml-5 space-y-1 text-muted-foreground">
        {details.map(({ name, message, count }) => {
          const tool = toolName(name);
          const reason = plainText(message) || t("refused.noReason");
          return (
            <li key={`${name}-${message}`} className="break-words whitespace-pre-wrap">
              {count > 1
                ? t("refused.itemRepeated", { tool, count, message: reason })
                : t("refused.item", { tool, message: reason })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
