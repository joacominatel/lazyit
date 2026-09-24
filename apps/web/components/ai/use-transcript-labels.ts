"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { runErrorKind } from "@/lib/ai/error-kinds";
import { presentPreview, type PreviewValue } from "@/lib/ai/preview";
import type { TranscriptLabels } from "@/lib/ai/transcript-markdown";
import { approvalStage } from "./ai-approval-card";
import { usePreviewFieldLabel, useToolDisplayName } from "./ai-labels";
import { toolLineText } from "./ai-tool-activity";

/**
 * The localized words `/copy` writes into the Markdown transcript (issue #1372) — the same strings the
 * chat shows: tool lines, approval stamps and field labels, run notices.
 */
export function useTranscriptLabels(): TranscriptLabels {
  const t = useTranslations("ai");
  const format = useFormatter();
  const toolName = useToolDisplayName();
  const fieldLabel = usePreviewFieldLabel();

  return useMemo<TranscriptLabels>(() => {
    const value = (v: PreviewValue | null): string => {
      if (v === null || v.kind === "empty") return t("approval.empty");
      switch (v.kind) {
        case "redacted":
          return t("approval.redacted");
        case "boolean":
          return v.value ? t("approval.yes") : t("approval.no");
        case "number":
          return format.number(v.value);
        case "date":
          return format.dateTime(new Date(v.iso), { dateStyle: "medium", timeStyle: "short" });
        case "text":
          return v.text.replace(/\s+/g, " ");
      }
    };
    return {
      you: t("message.you"),
      assistant: t("message.assistant"),
      tool: (part, count) => toolLineText(t, part.status, toolName(part.name), count),
      approval: (part, callStatus) => {
        const preview = part.request.preview;
        const model = presentPreview(preview);
        const elevated = part.request.elevated || preview.elevated;
        const stage = approvalStage(part.outcome, callStatus, null);
        const lines = [
          `**${t(`approval.classes.${elevated ? "elevated" : "write"}`)}** · ${t(`approval.states.${stage}`)}`,
          model.action ? model.action.text : t("approval.noAction"),
        ];
        for (const row of model.rows) {
          const after = value(row.after);
          const shown = row.before !== null ? `${value(row.before)} → ${after}` : after;
          lines.push(`- ${fieldLabel(row.field)}: ${shown}`);
        }
        return lines;
      },
      notice: (part) =>
        part.error.code === "CANCELLED"
          ? t("errors.run.CANCELLED")
          : t(`errors.run.${runErrorKind(part.error.code).key}`),
      unsupported: t("message.unsupported"),
    };
  }, [t, format, toolName, fieldLabel]);
}
