"use client";

import type { AiConversationSummary } from "@lazyit/shared";
import { TrashIcon } from "@heroicons/react/24/outline";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { RequestIdNote } from "@/components/request-id-note";
import { DEFAULT_TIME_ZONE } from "@/i18n/config";
import { refusalOf } from "@/lib/ai/error-kinds";
import { groupByRecency } from "@/lib/ai/history-groups";
import { notifyError } from "@/lib/api/notify-error";
import { useAiConversations, useDeleteAiConversation } from "@/lib/api/hooks/use-ai-conversations";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import { cn } from "@/lib/utils";

/**
 * The conversation list (frontend.md §5.2 `ConversationHistory`): the caller's own chats only (the API is
 * owner-only), grouped by recency, each deletable behind a confirm. Deleting hard-deletes the transcript;
 * the action ledger survives.
 */
export function AiConversationHistory({
  currentId,
  onOpen,
  onDeleted,
}: {
  currentId: string | null;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("ai.history");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const conversations = useAiConversations();
  const status = useAiStatus();
  const remove = useDeleteAiConversation();
  const [pending, setPending] = useState<AiConversationSummary | null>(null);

  const retentionDays = status.data?.retentionDays;

  async function confirmDelete() {
    if (!pending) return;
    try {
      await remove.mutateAsync(pending.id);
      toast.success(t("deleted"));
      onDeleted(pending.id);
      setPending(null);
    } catch (error) {
      if (refusalOf(error)?.code === "RUN_IN_PROGRESS") {
        toast.error(t("deleteInProgress"));
        setPending(null);
        return;
      }
      notifyError(error, t("deleteFailed"));
    }
  }

  const titleOf = (c: AiConversationSummary) => c.title?.trim() || t("untitled");

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("private")}{" "}
        {typeof retentionDays === "number"
          ? t("retention", { days: retentionDays })
          : retentionDays === null
            ? t("retentionNone")
            : null}
      </p>

      {conversations.isPending && (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {conversations.isError && (
        <div role="alert" className="mt-3 text-xs text-destructive-text">
          <p>{t("loadError")}</p>
          <RequestIdNote
            requestId={(conversations.error as { requestId?: string } | null)?.requestId}
            className="mt-1"
          />
        </div>
      )}

      {conversations.data && conversations.data.items.length === 0 && (
        <p className="mt-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      )}

      {conversations.data &&
        groupByRecency(conversations.data.items, now, DEFAULT_TIME_ZONE).map(({ group, items }) => (
          <section key={group} className="mt-4">
            <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t(`groups.${group}`)}
            </h4>
            <ul className="divide-y divide-border border-y border-border">
              {items.map((c) => (
                <li key={c.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    aria-current={c.id === currentId ? "true" : undefined}
                    className={cn(
                      "flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-sm px-2 py-1.5 text-left hover:bg-muted",
                      c.id === currentId && "bg-muted",
                    )}
                  >
                    <span className="w-full truncate text-sm">{titleOf(c)}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">
                        {format.dateTime(new Date(c.updatedAt), { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                      {c.status === "running" && <StatusBadge tone="info">{t("running")}</StatusBadge>}
                      {c.status === "awaiting-approval" && (
                        <StatusBadge tone="warning">{t("awaiting")}</StatusBadge>
                      )}
                      {c.readOnly && <StatusBadge tone="neutral">{t("readOnly")}</StatusBadge>}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("delete", { title: titleOf(c) })}
                    onClick={() => setPending(c)}
                  >
                    <TrashIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending ? t("deleteBody", { title: titleOf(pending) }) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t("cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => void confirmDelete()}
            >
              {t("deleteConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
