"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { runErrorKind } from "@/lib/ai/error-kinds";
import { displayAnswer, type AnswerDisplay } from "@/lib/ai/input-form";
import { presentPreview, type PreviewValue } from "@/lib/ai/preview";
import { plainText } from "@/lib/ai/untrusted-text";
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
        const kind = part.auto === true
          ? t("approval.auto.title")
          : t(`approval.classes.${elevated ? "elevated" : "write"}`);
        const lines = [
          `**${kind}** · ${t(`approval.states.${stage}`)}`,
          model.action ? model.action.text : t("approval.noAction"),
        ];
        for (const row of model.rows) {
          const after = value(row.after);
          const shown = row.before !== null ? `${value(row.before)} → ${after}` : after;
          lines.push(`- ${fieldLabel(row.field)}: ${shown}`);
        }
        return lines;
      },
      input: (part) => {
        const answered = (v: AnswerDisplay): string => {
          switch (v.kind) {
            case "empty":
              return t("input.empty");
            case "boolean":
              return v.value ? t("input.yes") : t("input.no");
            case "number":
              return format.number(v.value);
            case "date":
              return format.dateTime(new Date(`${v.day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
            case "list":
              return v.items.map(plainText).join(", ");
            case "text":
              return plainText(v.text).replace(/\s+/g, " ");
          }
        };
        const { form } = part.request;
        const lines = [
          `**${t("input.kicker")}** · ${t(`input.states.${part.outcome ?? "pending"}`)}`,
          plainText(form.title),
        ];
        const answer = part.outcome === "submitted" ? part.answer : undefined;
        if (answer) {
          for (const field of form.fields) {
            lines.push(`- ${plainText(field.label)}: ${answered(displayAnswer(field, answer.values[field.key]))}`);
          }
          for (const group of form.groups) {
            (answer.groups[group.key] ?? []).forEach((row, index) => {
              const cells = group.fields.map(
                (field) => `${plainText(field.label)}: ${answered(displayAnswer(field, row[field.key]))}`,
              );
              lines.push(`- ${plainText(group.label)} ${index + 1}: ${cells.join("; ")}`);
            });
          }
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
